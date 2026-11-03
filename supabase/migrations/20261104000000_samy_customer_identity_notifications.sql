-- PREPARATION ONLY: do not run this migration until reviewed and approved.
-- Adds per-device anonymous Supabase ownership for new bookings and private notification state.
-- Historical bookings intentionally keep customer_user_id = NULL.
begin;

alter table public.bookings
  add column if not exists customer_user_id uuid references auth.users(id) on delete set null;
create index if not exists bookings_customer_date_idx
  on public.bookings (customer_user_id, booking_date desc, start_time);

create table if not exists public.samy_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  booking_id text,
  event_type text not null check (event_type in ('booking_created','booking_cancelled','booking_reminder')),
  title text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists samy_notifications_recipient_idx
  on public.samy_notifications (recipient_user_id, created_at desc);
alter table public.samy_notifications enable row level security;
drop policy if exists samy_notifications_read_own on public.samy_notifications;
create policy samy_notifications_read_own on public.samy_notifications
  for select to authenticated using (recipient_user_id = auth.uid() or public.is_admin());
drop policy if exists samy_notifications_mark_own_read on public.samy_notifications;
create policy samy_notifications_mark_own_read on public.samy_notifications
  for update to authenticated using (recipient_user_id = auth.uid() or public.is_admin())
  with check (recipient_user_id = auth.uid() or public.is_admin());

create table if not exists public.samy_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists samy_push_subscriptions_user_idx on public.samy_push_subscriptions(user_id);
alter table public.samy_push_subscriptions enable row level security;
drop policy if exists samy_push_subscription_owner_all on public.samy_push_subscriptions;
create policy samy_push_subscription_owner_all on public.samy_push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Outbox separates durable in-app events from best-effort web-push delivery.
create table if not exists public.samy_push_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  booking_id text not null,
  event_type text not null check (event_type in ('booking_created','booking_cancelled','booking_reminder')),
  payload jsonb not null default '{}'::jsonb,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create unique index if not exists samy_push_outbox_once_idx
  on public.samy_push_outbox(booking_id, recipient_user_id, event_type);
create index if not exists samy_push_outbox_due_idx
  on public.samy_push_outbox(available_at) where sent_at is null;
alter table public.samy_push_outbox enable row level security;
-- No client-facing outbox policy: only trusted server/Edge Function service-role access.

-- Reminder queue has one durable claim per booking, independent of delivery retries.
create table if not exists public.samy_booking_reminders (
  booking_id text primary key,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  due_at timestamptz not null,
  queued_at timestamptz not null default now()
);
alter table public.samy_booking_reminders enable row level security;

create or replace function public.samy_my_bookings()
returns setof public.bookings
language sql stable security definer
set search_path = public, pg_temp
as $function$
  select b.* from public.bookings b
  where auth.uid() is not null and b.customer_user_id = auth.uid()
  order by b.booking_date desc, b.start_time desc;
$function$;
revoke all on function public.samy_my_bookings() from public, anon;
grant execute on function public.samy_my_bookings() to authenticated;

create or replace function public.samy_cancel_my_booking(p_booking_id text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $function$
declare v_booking public.bookings;
begin
  if auth.uid() is null then raise exception using errcode='P0001', message='customer_auth_required'; end if;
  update public.bookings b set status='cancelado'
    where b.id::text=p_booking_id
      and b.customer_user_id=auth.uid()
      and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
      and (b.booking_date::date + b.start_time::time) >= (now() at time zone 'America/Argentina/Buenos_Aires')
    returning b.* into v_booking;
  if not found then raise exception using errcode='P0001', message='booking_not_cancellable'; end if;
  return jsonb_build_object('id',v_booking.id::text,'status',v_booking.status::text);
end;
$function$;
revoke all on function public.samy_cancel_my_booking(text) from public, anon;
grant execute on function public.samy_cancel_my_booking(text) to authenticated;

-- Keep the existing atomic overlap check and service_parallel duration grouping intact.
-- The only booking-write changes are requiring an authenticated anonymous/customer session,
-- recording auth.uid(), and letting the existing booking trigger enqueue notifications.
create or replace function public.samy_create_booking(
  p_client_name text,
  p_client_phone text,
  p_booking_date date,
  p_start_time time,
  p_service_ids jsonb,
  p_notes text default ''
)
returns jsonb
language plpgsql security definer
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
  v_customer_user_id uuid := auth.uid();
begin
  if v_customer_user_id is null then
    raise exception using errcode='P0001', message='customer_auth_required';
  end if;
  if nullif(trim(p_client_name),'') is null or nullif(trim(p_client_phone),'') is null
     or p_booking_date is null or p_start_time is null
     or jsonb_typeof(p_service_ids) is distinct from 'array' or jsonb_array_length(p_service_ids)=0 then
    raise exception using errcode='P0001', message='invalid_booking_details';
  end if;
  if char_length(trim(p_client_name))>200 or char_length(trim(p_client_phone))>80
     or char_length(coalesce(p_notes,''))>3000 then
    raise exception using errcode='P0001', message='invalid_booking_details';
  end if;
  if p_booking_date < (now() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception using errcode='P0001', message='booking_date_in_past';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_booking_date::text,0));
  if jsonb_array_length(p_service_ids) <>
     (select count(distinct value) from jsonb_array_elements_text(p_service_ids) as ids(value)) then
    raise exception using errcode='P0001', message='invalid_service_selection';
  end if;
  for v_service in
    select s.id::text as service_id,s.duration_minutes::integer as duration_minutes
    from jsonb_array_elements_text(p_service_ids) with ordinality as requested(service_id,ord)
    join public.services s on s.id::text=requested.service_id
    where s.active is true order by requested.ord
  loop
    v_service_count:=v_service_count+1; v_group_index:=null;
    select (groups.ordinality-1)::integer into v_group_index
    from jsonb_array_elements(v_groups) with ordinality as groups(group_value,ordinality)
    where not exists (
      select 1 from jsonb_array_elements_text(groups.group_value->'service_ids') as members(service_id)
      where members.service_id<>v_service.service_id and not exists (
        select 1 from public.service_parallel pair
        where (pair.service_id::text=members.service_id and pair.parallel_service_id::text=v_service.service_id)
           or (pair.parallel_service_id::text=members.service_id and pair.service_id::text=v_service.service_id)
      )
    ) order by groups.ordinality limit 1;
    if v_group_index is null then
      v_groups:=v_groups||jsonb_build_array(jsonb_build_object('service_ids',jsonb_build_array(v_service.service_id),'duration_minutes',v_service.duration_minutes));
    else
      v_group:=v_groups->v_group_index;
      v_group:=jsonb_set(v_group,'{service_ids}',(v_group->'service_ids')||jsonb_build_array(v_service.service_id));
      v_group:=jsonb_set(v_group,'{duration_minutes}',to_jsonb(greatest((v_group->>'duration_minutes')::integer,v_service.duration_minutes)));
      v_groups:=jsonb_set(v_groups,array[v_group_index::text],v_group);
    end if;
  end loop;
  if v_service_count<>jsonb_array_length(p_service_ids) then
    raise exception using errcode='P0001', message='services_unavailable';
  end if;
  select coalesce(sum((group_value->>'duration_minutes')::integer),0) into v_duration
  from jsonb_array_elements(v_groups) as groups(group_value);
  if v_duration<=0 or not exists (
    select 1 from public.availability_slots a where a.slot_date::date=p_booking_date
      and a.slot_time::time=p_start_time and a.active is true
  ) then raise exception using errcode='P0001', message='slot_unavailable'; end if;
  v_start_minute:=floor(extract(epoch from (p_start_time-time '00:00'))/60)::integer;
  if exists (
    select 1 from public.bookings b where b.booking_date::date=p_booking_date
      and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
      and v_start_minute < floor(extract(epoch from (b.start_time::time-time '00:00'))/60)::integer+b.duration_minutes
      and floor(extract(epoch from (b.start_time::time-time '00:00'))/60)::integer < v_start_minute+v_duration
  ) then raise exception using errcode='P0001', message='slot_unavailable'; end if;
  v_metadata:='[[SAMY_NAILS_V1]]'||jsonb_build_object('notes',coalesce(p_notes,''),'service_ids',p_service_ids)::text;
  insert into public.bookings(client_name,client_phone,booking_date,start_time,duration_minutes,notes,customer_user_id)
  values(trim(p_client_name),trim(p_client_phone),p_booking_date,p_start_time,v_duration,v_metadata,v_customer_user_id)
  returning id::text into v_booking_id;
  return jsonb_build_object('id',v_booking_id,'duration_minutes',v_duration,'status','pendiente');
end;
$function$;
revoke all on function public.samy_create_booking(text,text,date,time,jsonb,text) from public;
grant execute on function public.samy_create_booking(text,text,date,time,jsonb,text) to anon, authenticated;

-- In-app and durable push events. A client cancellation notifies admins only;
-- an admin cancellation deliberately does not notify the client.
create or replace function public.samy_booking_notification_events()
returns trigger language plpgsql security definer
set search_path=public,pg_temp
as $function$
declare v_admin record; v_type text; v_title text; v_body text; v_payload jsonb;
begin
  if tg_op='INSERT' then
    if new.customer_user_id is null then return new; end if;
    v_type:='booking_created'; v_title:='Turno solicitado';
    v_body:='Recibimos tu solicitud de turno en Samy Nails.';
    v_payload:=jsonb_build_object('client_name',new.client_name,'booking_date',new.booking_date,'start_time',new.start_time,'status',new.status);
    insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
      values(new.customer_user_id,new.id::text,v_type,v_title,v_body,v_payload);
    insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
      values(new.customer_user_id,new.id::text,v_type,v_payload) on conflict do nothing;
    for v_admin in select user_id from public.admin_users loop
      insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
        values(v_admin.user_id,new.id::text,v_type,'Nuevo turno',
          new.client_name||' · '||new.booking_date::text||' · '||left(new.start_time::text,5),v_payload);
      insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
        values(v_admin.user_id,new.id::text,v_type,v_payload) on conflict do nothing;
    end loop;
  elsif tg_op='UPDATE' and lower(coalesce(new.status::text,'')) in ('cancelado','cancelada','canceled','cancelled','cancel')
       and lower(coalesce(old.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
       and auth.uid()=old.customer_user_id then
    v_payload:=jsonb_build_object('client_name',old.client_name,'booking_date',old.booking_date,'start_time',old.start_time);
    for v_admin in select user_id from public.admin_users loop
      insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
        values(v_admin.user_id,old.id::text,'booking_cancelled','Turno cancelado por la clienta',
          old.client_name||' · '||old.booking_date::text||' · '||left(old.start_time::text,5),v_payload);
      insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
        values(v_admin.user_id,old.id::text,'booking_cancelled',v_payload) on conflict do nothing;
    end loop;
  end if;
  return new;
end;
$function$;
drop trigger if exists samy_booking_notification_events on public.bookings;
create trigger samy_booking_notification_events after insert or update of status on public.bookings
  for each row execute function public.samy_booking_notification_events();

-- Called by the trusted scheduled Edge Function once per minute. A unique booking_id
-- claim prevents duplicate reminders from concurrent scheduler invocations.
create or replace function public.samy_enqueue_due_reminders()
returns integer language plpgsql security definer
set search_path=public,pg_temp
as $function$
declare v_count integer;
begin
  insert into public.samy_booking_reminders(booking_id,recipient_user_id,due_at)
  select b.id::text,b.customer_user_id,
    ((b.booking_date::date+b.start_time::time) at time zone 'America/Argentina/Buenos_Aires')-interval '24 hours'
  from public.bookings b
  where b.customer_user_id is not null
    and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
    and ((b.booking_date::date+b.start_time::time) at time zone 'America/Argentina/Buenos_Aires')
        between now()+interval '23 hours 59 minutes' and now()+interval '24 hours 1 minute'
  on conflict (booking_id) do nothing;
  get diagnostics v_count=row_count;
  insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
  select r.recipient_user_id,r.booking_id,'booking_reminder','¡Mañana te esperamos en Samy Nails! 💜',
    'Te recordamos que mañana tenés tu turno. ¡Tenemos todo preparado para vos! Tu turno: '
      ||to_char((b.booking_date::date+b.start_time::time) at time zone 'America/Argentina/Buenos_Aires','DD/MM/YYYY HH24:MI')||'. ¡Nos vemos!',
    jsonb_build_object('booking_date',b.booking_date,'start_time',b.start_time)
  from public.samy_booking_reminders r join public.bookings b on b.id::text=r.booking_id
  where r.queued_at >= now()-interval '2 minutes'
    and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
  on conflict do nothing;
  insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
  select r.recipient_user_id,r.booking_id,'booking_reminder',jsonb_build_object('booking_date',b.booking_date,'start_time',b.start_time)
  from public.samy_booking_reminders r join public.bookings b on b.id::text=r.booking_id
  where r.queued_at >= now()-interval '2 minutes'
    and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
  on conflict do nothing;
  return v_count;
end;
$function$;
revoke all on function public.samy_enqueue_due_reminders() from public,anon,authenticated;
grant execute on function public.samy_enqueue_due_reminders() to service_role;

commit;
