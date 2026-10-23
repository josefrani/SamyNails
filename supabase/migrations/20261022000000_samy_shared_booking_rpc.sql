-- Samy Nails: safe public availability and atomic shared booking creation.
-- Run this once in the Supabase SQL editor for the existing project.
begin;

-- service_parallel contains only scheduling relationships. Customers need to
-- read those relationships to see the same combined duration as the admin.
alter table public.service_parallel enable row level security;

drop policy if exists samy_public_read_service_parallel on public.service_parallel;
create policy samy_public_read_service_parallel
  on public.service_parallel
  for select
  to anon, authenticated
  using (true);

drop policy if exists samy_admin_manage_service_parallel on public.service_parallel;
create policy samy_admin_manage_service_parallel
  on public.service_parallel
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Public clients can create a booking only through the transaction below.
-- This avoids exposing booking rows and prevents simultaneous double booking.
drop policy if exists public_insert_bookings on public.bookings;

create or replace function public.samy_available_slots(
  p_date date,
  p_duration_minutes integer
)
returns table(slot_time text)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select to_char(a.slot_time::time, 'HH24:MI') as slot_time
  from public.availability_slots as a
  where a.slot_date::date = p_date
    and a.active is true
    and p_duration_minutes > 0
    and not exists (
      select 1
      from public.bookings as b
      where b.booking_date::date = p_date
        and lower(coalesce(b.status::text, '')) not in ('cancelado', 'cancelada', 'canceled', 'cancelled', 'cancel')
        and floor(extract(epoch from (a.slot_time::time - time '00:00')) / 60)
              < floor(extract(epoch from (b.start_time::time - time '00:00')) / 60)
                + b.duration_minutes
        and floor(extract(epoch from (b.start_time::time - time '00:00')) / 60)
              < floor(extract(epoch from (a.slot_time::time - time '00:00')) / 60)
                + p_duration_minutes
    )
  order by a.slot_time::time;
$function$;

create or replace function public.samy_create_booking(
  p_client_name text,
  p_client_phone text,
  p_booking_date date,
  p_start_time time,
  p_service_ids jsonb,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_service record;
  v_group jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_group_index integer;
  v_service_count integer := 0;
  v_duration integer := 0;
  v_start_minute integer;
  v_booking_id text;
  v_metadata text;
begin
  if nullif(trim(p_client_name), '') is null
     or nullif(trim(p_client_phone), '') is null
     or p_booking_date is null
     or p_start_time is null
     or jsonb_typeof(p_service_ids) is distinct from 'array'
     or jsonb_array_length(p_service_ids) = 0 then
    raise exception using errcode = 'P0001', message = 'invalid_booking_details';
  end if;
  if char_length(trim(p_client_name)) > 200
     or char_length(trim(p_client_phone)) > 80
     or char_length(coalesce(p_notes, '')) > 3000 then
    raise exception using errcode = 'P0001', message = 'invalid_booking_details';
  end if;
  if p_booking_date < current_date then
    raise exception using errcode = 'P0001', message = 'booking_date_in_past';
  end if;

  -- Serialize booking attempts for this date so concurrent requests cannot
  -- both pass the overlap check.
  perform pg_advisory_xact_lock(hashtextextended(p_booking_date::text, 0));

  if jsonb_array_length(p_service_ids) <>
     (select count(distinct value) from jsonb_array_elements_text(p_service_ids) as ids(value)) then
    raise exception using errcode = 'P0001', message = 'invalid_service_selection';
  end if;

  for v_service in
    select s.id::text as service_id, s.duration_minutes::integer as duration_minutes
    from jsonb_array_elements_text(p_service_ids) with ordinality as requested(service_id, ord)
    join public.services as s on s.id::text = requested.service_id
    where s.active is true
    order by requested.ord
  loop
    v_service_count := v_service_count + 1;
    v_group_index := null;

    select (groups.ordinality - 1)::integer
    into v_group_index
    from jsonb_array_elements(v_groups) with ordinality as groups(group_value, ordinality)
    where not exists (
      select 1
      from jsonb_array_elements_text(groups.group_value -> 'service_ids') as members(service_id)
      where members.service_id <> v_service.service_id
        and not exists (
          select 1
          from public.service_parallel as pair
          where (pair.service_id::text = members.service_id
                 and pair.parallel_service_id::text = v_service.service_id)
             or (pair.parallel_service_id::text = members.service_id
                 and pair.service_id::text = v_service.service_id)
        )
    )
    order by groups.ordinality
    limit 1;

    if v_group_index is null then
      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'service_ids', jsonb_build_array(v_service.service_id),
        'duration_minutes', v_service.duration_minutes
      ));
    else
      v_group := v_groups -> v_group_index;
      v_group := jsonb_set(
        v_group,
        '{service_ids}',
        (v_group -> 'service_ids') || jsonb_build_array(v_service.service_id)
      );
      v_group := jsonb_set(
        v_group,
        '{duration_minutes}',
        to_jsonb(greatest((v_group ->> 'duration_minutes')::integer, v_service.duration_minutes))
      );
      v_groups := jsonb_set(v_groups, array[v_group_index::text], v_group);
    end if;
  end loop;

  if v_service_count <> jsonb_array_length(p_service_ids) then
    raise exception using errcode = 'P0001', message = 'services_unavailable';
  end if;

  select coalesce(sum((group_value ->> 'duration_minutes')::integer), 0)
  into v_duration
  from jsonb_array_elements(v_groups) as groups(group_value);

  if v_duration <= 0
     or not exists (
       select 1
       from public.availability_slots as a
       where a.slot_date::date = p_booking_date
         and a.slot_time::time = p_start_time
         and a.active is true
     ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  v_start_minute := floor(extract(epoch from (p_start_time - time '00:00')) / 60)::integer;
  if exists (
    select 1
    from public.bookings as b
    where b.booking_date::date = p_booking_date
      and lower(coalesce(b.status::text, '')) not in ('cancelado', 'cancelada', 'canceled', 'cancelled', 'cancel')
      and v_start_minute < floor(extract(epoch from (b.start_time::time - time '00:00')) / 60)::integer
            + b.duration_minutes
      and floor(extract(epoch from (b.start_time::time - time '00:00')) / 60)::integer
            < v_start_minute + v_duration
  ) then
    raise exception using errcode = 'P0001', message = 'slot_unavailable';
  end if;

  v_metadata := '[[SAMY_NAILS_V1]]' || jsonb_build_object(
    'notes', coalesce(p_notes, ''),
    'service_ids', p_service_ids
  )::text;

  insert into public.bookings (
    client_name,
    client_phone,
    booking_date,
    start_time,
    duration_minutes,
    notes
  )
  values (
    trim(p_client_name),
    trim(p_client_phone),
    p_booking_date,
    p_start_time,
    v_duration,
    v_metadata
  )
  returning id::text into v_booking_id;

  return jsonb_build_object(
    'id', v_booking_id,
    'duration_minutes', v_duration,
    'status', 'pendiente'
  );
end;
$function$;

revoke all on function public.samy_available_slots(date, integer) from public;
revoke all on function public.samy_create_booking(text, text, date, time, jsonb, text) from public;
grant execute on function public.samy_available_slots(date, integer) to anon, authenticated;
grant execute on function public.samy_create_booking(text, text, date, time, jsonb, text) to anon, authenticated;

commit;
