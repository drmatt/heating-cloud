-- Energy saving: eco settings and learned models per zone, the home's
-- location for weather, daily energy figures, and season advice.

-- Supabase gives anon and authenticated full access to new tables and
-- functions by default. Stop that, so every table here grants exactly what
-- it needs (as the first migration does for its tables).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Location (rounded to about 1 km) for outside temperatures

alter table public.homes
  add column latitude numeric(5,2) check (latitude between -90 and 90),
  add column longitude numeric(5,2) check (longitude between -180 and 180);

grant update (latitude, longitude) on public.homes to authenticated;

-- ---------------------------------------------------------------------------
-- Eco settings and what the controller has learned

alter table public.zones
  add column eco_enabled boolean not null default true,
  add column comfort_margin numeric(2,1) not null default 1.0 check (comfort_margin between 0 and 2),
  add column model jsonb;

-- zones that already exist start with eco off, so owners switch it on when
-- they're ready; new zones get it from the start
update public.zones set eco_enabled = false;

grant update (eco_enabled, comfort_margin) on public.zones to authenticated;

-- ---------------------------------------------------------------------------
-- Daily figures from the controller, for the energy summary

create table public.zone_daily (
  home_id uuid not null references public.homes(id) on delete cascade,
  zone_local_id integer not null,
  day date not null,
  boiler_minutes integer not null default 0,
  eco_minutes integer not null default 0,     -- minutes eco held off heat the original rule would have given
  mean_outdoor numeric(4,1),
  hdd numeric(4,1),                           -- heating degree days, base 15.5 °C
  mean_temp numeric(4,1),
  primary key (home_id, zone_local_id, day)
);

alter table public.zone_daily enable row level security;
revoke all on public.zone_daily from anon, authenticated;
grant select, insert, update on public.zone_daily to authenticated;

create policy "read daily figures" on public.zone_daily
  for select using (public.can_access_home(home_id));
create policy "controller adds daily figures" on public.zone_daily
  for insert with check (home_id = public.controller_home());
create policy "controller updates daily figures" on public.zone_daily
  for update using (home_id = public.controller_home()) with check (home_id = public.controller_home());

-- ---------------------------------------------------------------------------
-- Notifications: season advice, shown on the dashboard and emailed

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  kind text not null check (kind in ('switch_on', 'switch_off')),
  title text not null,
  body text not null,
  action jsonb not null default '{}'::jsonb,   -- { zone_local_ids: [...] }
  created_at timestamptz not null default now(),
  dismissed_at timestamptz,
  emailed_at timestamptz
);

create index notifications_home on public.notifications (home_id, created_at desc);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (dismissed_at) on public.notifications to authenticated;

create policy "read notifications" on public.notifications
  for select using (public.can_access_home(home_id));
create policy "members dismiss notifications" on public.notifications
  for update using (public.is_home_member(home_id)) with check (public.is_home_member(home_id));

alter table public.home_members add column notify_email boolean not null default true;
grant update (notify_email) on public.home_members to authenticated;
create policy "members set their own email preference" on public.home_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Advice from the controller. The same kind isn't repeated within 7 days,
-- whether or not the last one was acted on.
create function public.controller_notify(p_kind text, p_title text, p_body text, p_zone_local_ids int[])
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_home uuid := public.controller_home();
  v_id uuid;
begin
  if v_home is null then
    raise exception 'Not a claimed controller';
  end if;
  if exists (select 1 from notifications where home_id = v_home and kind = p_kind and created_at > now() - interval '7 days') then
    return null;
  end if;
  insert into notifications (home_id, kind, title, body, action)
    values (v_home, p_kind, left(p_title, 200), left(p_body, 1000), jsonb_build_object('zone_local_ids', to_jsonb(coalesce(p_zone_local_ids, '{}'))))
    returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- controller_sync now also takes learned models and returns the location and
-- eco settings

create or replace function public.controller_sync(p_report jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_controller controllers;
  v_home uuid;
  v_imported boolean := false;
  v_home_row homes;
begin
  select * into v_controller from controllers where auth_user_id = auth.uid();
  if not found then
    raise exception 'Not a controller';
  end if;

  update controllers set last_seen_at = now(), software_version = p_report->>'software_version'
    where id = v_controller.id;

  v_home := v_controller.home_id;
  if v_home is null then
    return jsonb_build_object('claimed', false, 'claim_code', v_controller.claim_code);
  end if;

  -- first sync for this home: import the controller's set-up
  if not exists (select 1 from zones where home_id = v_home) then
    v_imported := true;

    insert into zones (home_id, local_id, name, is_enabled)
      select v_home, (z->>'local_id')::int, left(coalesce(nullif(trim(z->>'name'), ''), 'Zone ' || (z->>'local_id')), 40),
             coalesce((z->>'is_enabled')::boolean, true)
      from jsonb_array_elements(coalesce(p_report->'zones', '[]'::jsonb)) z;

    insert into schedule_slots (home_id, zone_id, day, on_time, off_time, temp)
      select v_home, zn.id, (s->>'day')::smallint, (s->>'on_time')::time, (s->>'off_time')::time,
             least(greatest((s->>'temp')::numeric, 5), 30)
      from jsonb_array_elements(coalesce(p_report->'schedule', '[]'::jsonb)) s
      join zones zn on zn.home_id = v_home and zn.local_id = (s->>'zone_local_id')::int
      where (s->>'off_time')::time > (s->>'on_time')::time;

    insert into sensors (home_id, device_id, name, zone_id)
      select v_home, s->>'device_id', left(coalesce(nullif(trim(s->>'name'), ''), s->>'device_id'), 20), zn.id
      from jsonb_array_elements(coalesce(p_report->'sensors', '[]'::jsonb)) s
      left join zones zn on zn.home_id = v_home and zn.local_id = (s->>'zone_local_id')::int
      on conflict do nothing;
  end if;

  -- live state
  update zones zn set
    is_on = (z->>'is_on')::boolean,
    desired_temp = (z->>'desired_temp')::numeric,
    current_temp = (z->>'current_temp')::numeric,
    state_updated_at = now()
  from jsonb_array_elements(coalesce(p_report->'zones', '[]'::jsonb)) z
  where zn.home_id = v_home and zn.local_id = (z->>'local_id')::int;

  update zones zn set model = m->'model'
  from jsonb_array_elements(coalesce(p_report->'models', '[]'::jsonb)) m
  where zn.home_id = v_home and zn.local_id = (m->>'local_id')::int;

  update sensors sn set
    last_temp = (s->>'last_temp')::numeric,
    last_battery = (s->>'last_battery')::int,
    last_seen_at = (s->>'last_seen_at')::timestamptz
  from jsonb_array_elements(coalesce(p_report->'sensor_states', '[]'::jsonb)) s
  where sn.home_id = v_home and sn.device_id = s->>'device_id';

  select * into v_home_row from homes where id = v_home;

  -- what the controller should apply
  return jsonb_build_object(
    'claimed', true,
    'home_id', v_home,
    'imported', v_imported,
    'location', jsonb_build_object('latitude', v_home_row.latitude, 'longitude', v_home_row.longitude),
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object('local_id', local_id, 'name', name, 'is_enabled', is_enabled,
                                          'boost_until', boost_until, 'eco_enabled', eco_enabled,
                                          'comfort_margin', comfort_margin) order by local_id)
      from zones where home_id = v_home), '[]'::jsonb),
    'schedule', coalesce((
      select jsonb_agg(jsonb_build_object('zone_local_id', zn.local_id, 'day', s.day,
                                          'on_time', s.on_time, 'off_time', s.off_time, 'temp', s.temp)
                       order by zn.local_id, s.day, s.on_time)
      from schedule_slots s join zones zn on zn.id = s.zone_id where s.home_id = v_home), '[]'::jsonb),
    'sensors', coalesce((
      select jsonb_agg(jsonb_build_object('device_id', sn.device_id, 'name', sn.name, 'zone_local_id', zn.local_id)
                       order by sn.device_id)
      from sensors sn left join zones zn on zn.id = sn.zone_id where sn.home_id = v_home), '[]'::jsonb)
  );
end;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
