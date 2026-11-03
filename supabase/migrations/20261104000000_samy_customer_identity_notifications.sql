-- PREPARATION ONLY: do not run this migration until reviewed and approved.
-- Adds per-device anonymous Supabase ownership for new bookings and private notification state.
-- Historical bookings intentionally keep customer_user_id = NULL.
begin;

alter table public.bookings
  add column if not exists customer_user_id uuid references auth.users(id) on delete set null;
create index if not exists bookings_customer_date_idx
  on public.bookings (customer_user_id, booking_date desc, start_time);

-- Restrictive policies fence older permissive policies: authenticated customers only
-- see their own rows; admins retain access. Customer writes must use the RPCs below.
alter table public.bookings enable row level security;
drop policy if exists samy_booking_owner_admin_scope on public.bookings;
create policy samy_booking_owner_admin_scope on public.bookings as restrictive
  for all to authenticated
  using (customer_user_id = auth.uid() or public.is_admin())
  with check (customer_user_id = auth.uid() or public.is_admin());
drop policy if exists samy_booking_anon_deny on public.bookings;
create policy samy_booking_anon_deny on public.bookings as restrictive
  for all to anon using (false) with check (false);
drop policy if exists samy_booking_customer_select_own on public.bookings;
create policy samy_booking_customer_select_own on public.bookings
  for select to authenticated using (customer_user_id = auth.uid() or public.is_admin());
drop policy if exists samy_booking_admin_all on public.bookings;
create policy samy_booking_admin_all on public.bookings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists samy_booking_customer_update_admin_only on public.bookings;
create policy samy_booking_customer_update_admin_only on public.bookings as restrictive
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists samy_booking_customer_insert_admin_only on public.bookings;
create policy samy_booking_customer_insert_admin_only on public.bookings as restrictive
  for insert to authenticated with check (public.is_admin());
drop policy if exists samy_booking_no_physical_delete on public.bookings;
create policy samy_booking_no_physical_delete on public.bookings as restrictive
  for delete to anon, authenticated using (false);

create table if not exists public.samy_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  booking_id text,
  event_type text not null check (event_type in ('booking_created','booking_confirmed','booking_cancelled','booking_reminder')),
  title text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists samy_notifications_booking_event_once_idx
  on public.samy_notifications (booking_id, recipient_user_id, event_type)
  where booking_id is not null;
create index if not exists samy_notifications_recipient_idx
  on public.samy_notifications (recipient_user_id, created_at desc);
alter table public.samy_notifications enable row level security;
drop policy if exists samy_notifications_read_own on public.samy_notifications;
create policy samy_notifications_read_own on public.samy_notifications
  for select to authenticated using (recipient_user_id = auth.uid() or public.is_admin());
revoke all on public.samy_notifications from anon, authenticated;
grant select on public.samy_notifications to authenticated;

create or replace function public.samy_mark_notification_read(p_notification_id uuid)
returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $function$
declare v_rows integer;
begin
  if auth.uid() is null then raise exception using errcode='P0001', message='authentication_required'; end if;
  update public.samy_notifications n set read_at=coalesce(n.read_at,now())
  where n.id=p_notification_id and (n.recipient_user_id=auth.uid() or public.is_admin());
  get diagnostics v_rows=row_count;
  return v_rows=1;
end;
$function$;
revoke all on function public.samy_mark_notification_read(uuid) from public, anon;
grant execute on function public.samy_mark_notification_read(uuid) to authenticated;

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
  for all to authenticated using (user_id=auth.uid() or public.is_admin())
  with check (user_id=auth.uid() or public.is_admin());
grant select, insert, update, delete on public.samy_push_subscriptions to authenticated;

create table if not exists public.samy_push_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  booking_id text not null,
  event_type text not null check (event_type in ('booking_created','booking_confirmed','booking_cancelled','booking_reminder')),
  payload jsonb not null default '{}'::jsonb,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create unique index if not exists samy_push_outbox_once_idx
  on public.samy_push_outbox(booking_id,recipient_user_id,event_type);
create index if not exists samy_push_outbox_due_idx
  on public.samy_push_outbox(available_at) where sent_at is null;
alter table public.samy_push_outbox enable row level security;
revoke all on public.samy_push_outbox from public, anon, authenticated;
grant all on public.samy_push_outbox to service_role;

create table if not exists public.samy_booking_reminders (
  booking_id text primary key,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  due_at timestamptz not null,
  queued_at timestamptz not null default now()
);
alter table public.samy_booking_reminders enable row level security;
revoke all on public.samy_booking_reminders from public, anon, authenticated;
grant all on public.samy_booking_reminders to service_role;

create or replace function public.samy_my_bookings()
returns setof public.bookings language sql stable security definer
set search_path = public, pg_temp
as $function$
  select b.* from public.bookings b
  where auth.uid() is not null and b.customer_user_id=auth.uid()
  order by b.booking_date desc,b.start_time desc;
$function$;
revoke all on function public.samy_my_bookings() from public, anon;
grant execute on function public.samy_my_bookings() to authenticated;

create or replace function public.samy_cancel_my_booking(p_booking_id text)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $function$
declare v_booking public.bookings;
begin
  if auth.uid() is null or public.is_admin() then
    raise exception using errcode='P0001',message='customer_auth_required';
  end if;
  update public.bookings b set status='cancelado'
  where b.id::text=p_booking_id and b.customer_user_id=auth.uid()
    and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
    and (b.booking_date::date+b.start_time::time) >= (now() at time zone 'America/Argentina/Buenos_Aires')
  returning b.* into v_booking;
  if not found then raise exception using errcode='P0001',message='booking_not_cancellable'; end if;
  return jsonb_build_object('id',v_booking.id::text,'status',v_booking.status::text);
end;
$function$;
revoke all on function public.samy_cancel_my_booking(text) from public, anon;
grant execute on function public.samy_cancel_my_booking(text) to authenticated;

-- Existing availability, advisory lock, overlap check and service_parallel grouping are preserved.
-- Admin-created manual bookings deliberately receive NULL customer_user_id.
create or replace function public.samy_create_booking(
  p_client_name text,p_client_phone text,p_booking_date date,p_start_time time,
  p_service_ids jsonb,p_notes text default ''
)
returns jsonb language plpgsql security definer
set search_path=public,pg_temp
as $function$
declare
  v_service record; v_group jsonb; v_groups jsonb:='[]'::jsonb; v_group_index integer;
  v_service_count integer:=0; v_duration integer:=0; v_start_minute integer;
  v_booking_id text; v_metadata text;
  v_customer_user_id uuid;
begin
  if auth.uid() is null then raise exception using errcode='P0001',message='customer_auth_required'; end if;
  v_customer_user_id:=case when public.is_admin() then null else auth.uid() end;
  if nullif(trim(p_client_name),'') is null or nullif(trim(p_client_phone),'') is null
     or p_booking_date is null or p_start_time is null
     or jsonb_typeof(p_service_ids) is distinct from 'array' or jsonb_array_length(p_service_ids)=0 then
    raise exception using errcode='P0001',message='invalid_booking_details';
  end if;
  if char_length(trim(p_client_name))>200 or char_length(trim(p_client_phone))>80 or char_length(coalesce(p_notes,''))>3000 then
    raise exception using errcode='P0001',message='invalid_booking_details';
  end if;
  if p_booking_date<(now() at time zone 'America/Argentina/Buenos_Aires')::date then
    raise exception using errcode='P0001',message='booking_date_in_past';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_booking_date::text,0));
  if jsonb_array_length(p_service_ids)<>(select count(distinct value) from jsonb_array_elements_text(p_service_ids) as ids(value)) then
    raise exception using errcode='P0001',message='invalid_service_selection';
  end if;
  for v_service in
    select s.id::text service_id,s.duration_minutes::integer duration_minutes
    from jsonb_array_elements_text(p_service_ids) with ordinality requested(service_id,ord)
    join public.services s on s.id::text=requested.service_id
    where s.active is true order by requested.ord
  loop
    v_service_count:=v_service_count+1; v_group_index:=null;
    select (groups.ordinality-1)::integer into v_group_index
    from jsonb_array_elements(v_groups) with ordinality groups(group_value,ordinality)
    where not exists(
      select 1 from jsonb_array_elements_text(groups.group_value->'service_ids') members(service_id)
      where members.service_id<>v_service.service_id and not exists(
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
  if v_service_count<>jsonb_array_length(p_service_ids) then raise exception using errcode='P0001',message='services_unavailable'; end if;
  select coalesce(sum((group_value->>'duration_minutes')::integer),0) into v_duration from jsonb_array_elements(v_groups) groups(group_value);
  if v_duration<=0 or not exists(select 1 from public.availability_slots a where a.slot_date::date=p_booking_date and a.slot_time::time=p_start_time and a.active is true) then
    raise exception using errcode='P0001',message='slot_unavailable';
  end if;
  v_start_minute:=floor(extract(epoch from (p_start_time-time '00:00'))/60)::integer;
  if exists(select 1 from public.bookings b where b.booking_date::date=p_booking_date
    and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
    and v_start_minute<floor(extract(epoch from (b.start_time::time-time '00:00'))/60)::integer+b.duration_minutes
    and floor(extract(epoch from (b.start_time::time-time '00:00'))/60)::integer<v_start_minute+v_duration) then
    raise exception using errcode='P0001',message='slot_unavailable';
  end if;
  v_metadata:='[[SAMY_NAILS_V1]]'||jsonb_build_object('notes',coalesce(p_notes,''),'service_ids',p_service_ids)::text;
  insert into public.bookings(client_name,client_phone,booking_date,start_time,duration_minutes,notes,customer_user_id)
  values(trim(p_client_name),trim(p_client_phone),p_booking_date,p_start_time,v_duration,v_metadata,v_customer_user_id)
  returning id::text into v_booking_id;
  return jsonb_build_object('id',v_booking_id,'duration_minutes',v_duration,'status','pendiente');
end;
$function$;
revoke all on function public.samy_create_booking(text,text,date,time,jsonb,text) from public,anon;
grant execute on function public.samy_create_booking(text,text,date,time,jsonb,text) to authenticated;

-- Notification event idempotency is enforced by unique (booking, recipient, event_type).
-- Client bookings notify admins on request; clients get a confirmation only when status is confirmed.
-- Admin manual bookings are not attributed to the admin account and do not self-notify.
create or replace function public.samy_booking_notification_events()
returns trigger language plpgsql security definer
set search_path=public,pg_temp
as $function$
declare
  v_admin record; v_services text:=''; v_payload jsonb; v_body text;
  v_confirmed boolean; v_cancelled boolean;
begin
  begin
    if coalesce(new.notes,'') like '[[SAMY_NAILS_V1]]%' then
      select coalesce(string_agg(s.name,' + ' order by s.name),'') into v_services
      from jsonb_array_elements_text((substring(new.notes from length('[[SAMY_NAILS_V1]]')+1)::jsonb)->'service_ids') ids(service_id)
      join public.services s on s.id::text=ids.service_id;
    end if;
  exception when others then v_services:='';
  end;
  v_payload:=jsonb_build_object('client_name',new.client_name,'services',v_services,
    'booking_date',new.booking_date,'start_time',left(new.start_time::text,5),'status',new.status);
  v_confirmed:=lower(coalesce(new.status::text,'')) in ('confirmado','confirmada','confirmed');
  v_cancelled:=lower(coalesce(new.status::text,'')) in ('cancelado','cancelada','canceled','cancelled','cancel');
  if tg_op='INSERT' then
    if not public.is_admin() then
      v_body:=new.client_name||' · '||coalesce(v_services,'')||' · '||new.booking_date::text||' · '||left(new.start_time::text,5);
      for v_admin in select user_id from public.admin_users loop
        insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
          values(v_admin.user_id,new.id::text,'booking_created','Nuevo turno',v_body,v_payload) on conflict do nothing;
        insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
          values(v_admin.user_id,new.id::text,'booking_created',v_payload||jsonb_build_object('message',v_body)) on conflict do nothing;
      end loop;
    end if;
    if new.customer_user_id is not null and v_confirmed then
      insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
        values(new.customer_user_id,new.id::text,'booking_confirmed','Turno confirmado','¡Tu turno en Samy Nails está confirmado! 💜',v_payload) on conflict do nothing;
      insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
        values(new.customer_user_id,new.id::text,'booking_confirmed',v_payload||jsonb_build_object('message','¡Tu turno en Samy Nails está confirmado! 💜')) on conflict do nothing;
    end if;
  elsif tg_op='UPDATE' then
    if new.customer_user_id is not null and v_confirmed
       and lower(coalesce(old.status::text,'')) not in ('confirmado','confirmada','confirmed') then
      insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
        values(new.customer_user_id,new.id::text,'booking_confirmed','Turno confirmado','¡Tu turno en Samy Nails está confirmado! 💜',v_payload) on conflict do nothing;
      insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
        values(new.customer_user_id,new.id::text,'booking_confirmed',v_payload||jsonb_build_object('message','¡Tu turno en Samy Nails está confirmado! 💜')) on conflict do nothing;
    elsif v_cancelled and not public.is_admin() and auth.uid()=old.customer_user_id
       and lower(coalesce(old.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel') then
      v_body:=old.client_name||' · '||coalesce(v_services,'')||' · '||old.booking_date::text||' · '||left(old.start_time::text,5);
      for v_admin in select user_id from public.admin_users loop
        insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
          values(v_admin.user_id,old.id::text,'booking_cancelled','Turno cancelado por la clienta',v_body,v_payload) on conflict do nothing;
        insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
          values(v_admin.user_id,old.id::text,'booking_cancelled',v_payload||jsonb_build_object('message',v_body)) on conflict do nothing;
      end loop;
    end if;
  end if;
  return new;
end;
$function$;
drop trigger if exists samy_booking_notification_events on public.bookings;
create trigger samy_booking_notification_events after insert or update of status on public.bookings
  for each row execute function public.samy_booking_notification_events();

-- Reminder queue and both notification channels are inserted only for rows newly claimed
-- by this call. Repeated cron invocations cannot duplicate internal notifications/outbox.
create or replace function public.samy_enqueue_due_reminders()
returns integer language plpgsql security definer
set search_path=public,pg_temp
as $function$
declare v_count integer;
begin
  with newly_queued as (
    insert into public.samy_booking_reminders(booking_id,recipient_user_id,due_at)
    select b.id::text,b.customer_user_id,
      ((b.booking_date::date+b.start_time::time) at time zone 'America/Argentina/Buenos_Aires')-interval '24 hours'
    from public.bookings b
    where b.customer_user_id is not null
      and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
      and ((b.booking_date::date+b.start_time::time) at time zone 'America/Argentina/Buenos_Aires')-interval '24 hours' <= now()
    on conflict(booking_id) do nothing returning booking_id,recipient_user_id
  ), internal_events as (
    insert into public.samy_notifications(recipient_user_id,booking_id,event_type,title,body,payload)
    select q.recipient_user_id,q.booking_id,'booking_reminder','¡Mañana te esperamos en Samy Nails! 💜',
      'Te recordamos que mañana tenés tu turno. ¡Tenemos todo preparado para vos! Tu turno: '
        ||to_char((b.booking_date::date+b.start_time::time) at time zone 'America/Argentina/Buenos_Aires','DD/MM/YYYY HH24:MI')||'. ¡Nos vemos!',
      jsonb_build_object('booking_date',b.booking_date,'start_time',left(b.start_time::text,5))
    from newly_queued q join public.bookings b on b.id::text=q.booking_id
    where lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
    on conflict do nothing returning id
  ), push_events as (
    insert into public.samy_push_outbox(recipient_user_id,booking_id,event_type,payload)
    select q.recipient_user_id,q.booking_id,'booking_reminder',jsonb_build_object(
      'booking_date',b.booking_date,'start_time',left(b.start_time::text,5),
      'message','¡Mañana te esperamos en Samy Nails! 💜 Te recordamos que mañana tenés tu turno. ¡Tenemos todo preparado para vos!')
    from newly_queued q join public.bookings b on b.id::text=q.booking_id
    where lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
    on conflict do nothing returning id
  ) select count(*) into v_count from newly_queued;
  return v_count;
end;
$function$;
revoke all on function public.samy_enqueue_due_reminders() from public,anon,authenticated;
grant execute on function public.samy_enqueue_due_reminders() to service_role;

-- Atomic, bounded, concurrent-safe worker claim. A stale claim can be retried after a crash.
create or replace function public.samy_claim_push_outbox(p_limit integer default 50)
returns setof public.samy_push_outbox language plpgsql security definer
set search_path=public,pg_temp
as $function$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
  return query
  with candidates as (
    select o.id from public.samy_push_outbox o
    where o.sent_at is null and o.available_at<=now()
      and (o.claimed_at is null or o.claimed_at<now()-interval '5 minutes')
      and (o.event_type<>'booking_reminder' or exists(
        select 1 from public.bookings b where b.id::text=o.booking_id
          and lower(coalesce(b.status::text,'')) not in ('cancelado','cancelada','canceled','cancelled','cancel')
          and (b.booking_date::date+b.start_time::time)>(now() at time zone 'America/Argentina/Buenos_Aires')
      ))
    order by o.available_at,o.created_at
    for update skip locked limit greatest(1,least(coalesce(p_limit,50),100))
  )
  update public.samy_push_outbox o set claimed_at=now(),attempts=o.attempts+1
  from candidates c where o.id=c.id returning o.*;
end;
$function$;
revoke all on function public.samy_claim_push_outbox(integer) from public,anon,authenticated;
grant execute on function public.samy_claim_push_outbox(integer) to service_role;

commit;
