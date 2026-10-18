-- Heating cloud: homes, controllers (Raspberry Pis), zones, schedules,
-- sensors, readings and commands.
--
-- Two kinds of signed-in user:
--   * customers, who belong to homes through home_members
--   * controllers, one Supabase user per Raspberry Pi, created by the
--     register-controller edge function and linked through controllers.auth_user_id
--
-- Customers read their own home's rows through row-level security. Writes that
-- need checking across tables go through the functions at the end of this file.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables

create table public.homes (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My home' check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);

create table public.home_members (
  home_id uuid not null references public.homes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (home_id, user_id)
);

create table public.controllers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  home_id uuid references public.homes(id) on delete set null,
  claim_code text unique,
  name text not null default 'Heating controller' check (char_length(name) between 1 and 60),
  software_version text,
  last_seen_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

-- one controller per home for now
create unique index controllers_one_per_home on public.controllers (home_id) where home_id is not null;

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  local_id integer not null,                 -- zones.id in the controller's own database
  name text not null check (char_length(name) between 1 and 40),
  is_enabled boolean not null default true,
  boost_until timestamptz,
  -- reported by the controller
  is_on boolean,
  desired_temp numeric(4,1),
  current_temp numeric(4,1),
  state_updated_at timestamptz,
  unique (home_id, local_id)
);

create table public.schedule_slots (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  zone_id uuid not null references public.zones(id) on delete cascade,
  day smallint not null check (day between 0 and 6),   -- 0 = Sunday, as on the controller
  on_time time not null,
  off_time time not null,
  temp numeric(4,1) not null check (temp between 5 and 30),
  check (off_time > on_time)
);

create index schedule_slots_zone on public.schedule_slots (zone_id);

create table public.sensors (
  home_id uuid not null references public.homes(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 20),
  name text not null check (char_length(name) between 1 and 20),
  zone_id uuid references public.zones(id) on delete set null,
  last_temp numeric(5,2),
  last_battery integer,
  last_seen_at timestamptz,
  primary key (home_id, device_id)
);

create table public.readings (
  home_id uuid not null references public.homes(id) on delete cascade,
  device_id text not null,
  time timestamptz not null,
  temp numeric(5,2) not null,
  battery integer,
  primary key (home_id, device_id, time)
);

create index readings_home_time on public.readings (home_id, time desc);

create table public.zone_events (
  home_id uuid not null references public.homes(id) on delete cascade,
  zone_local_id integer not null,
  time timestamptz not null,
  type text not null,
  value text not null,
  primary key (home_id, zone_local_id, time, type)
);

-- Work for the controller that has to happen in the house, such as Bluetooth
-- pairing. The dashboard inserts a command and the controller picks it up.
create table public.commands (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  type text not null check (type in ('scan_sensors', 'pair_sensor', 'set_sensor_network')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  result jsonb,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index commands_pending on public.commands (home_id, created_at) where status in ('pending', 'running');

-- ---------------------------------------------------------------------------
-- Who is asking

create function public.is_home_member(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from home_members where home_id = h and user_id = auth.uid());
$$;

-- The home of the controller making the request, or null for anyone else
create function public.controller_home() returns uuid
language sql stable security definer set search_path = public as $$
  select home_id from controllers where auth_user_id = auth.uid();
$$;

create function public.can_access_home(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_home_member(h) or public.controller_home() = h;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security

alter table public.homes enable row level security;
alter table public.home_members enable row level security;
alter table public.controllers enable row level security;
alter table public.zones enable row level security;
alter table public.schedule_slots enable row level security;
alter table public.sensors enable row level security;
alter table public.readings enable row level security;
alter table public.zone_events enable row level security;
alter table public.commands enable row level security;

-- Nothing is writable unless granted below
revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;

create policy "members read their homes" on public.homes
  for select using (public.can_access_home(id));
grant update (name) on public.homes to authenticated;
create policy "members rename their homes" on public.homes
  for update using (public.is_home_member(id)) with check (public.is_home_member(id));

create policy "members read their home's members" on public.home_members
  for select using (public.is_home_member(home_id));

create policy "members and the controller read controllers" on public.controllers
  for select using (public.is_home_member(home_id) or auth_user_id = auth.uid());
grant update (name) on public.controllers to authenticated;
create policy "members rename their controller" on public.controllers
  for update using (public.is_home_member(home_id)) with check (public.is_home_member(home_id));

create policy "read zones" on public.zones
  for select using (public.can_access_home(home_id));
grant update (name, is_enabled, boost_until) on public.zones to authenticated;
create policy "members change zones" on public.zones
  for update using (public.is_home_member(home_id)) with check (public.is_home_member(home_id));

create policy "read schedule" on public.schedule_slots
  for select using (public.can_access_home(home_id));

create policy "read sensors" on public.sensors
  for select using (public.can_access_home(home_id));

create policy "read readings" on public.readings
  for select using (public.can_access_home(home_id));
grant insert on public.readings to authenticated;
create policy "controller adds readings" on public.readings
  for insert with check (home_id = public.controller_home());

create policy "read zone events" on public.zone_events
  for select using (public.can_access_home(home_id));
grant insert on public.zone_events to authenticated;
create policy "controller adds zone events" on public.zone_events
  for insert with check (home_id = public.controller_home());

create policy "read commands" on public.commands
  for select using (public.can_access_home(home_id));
grant insert (home_id, type, payload) on public.commands to authenticated;
create policy "members add commands" on public.commands
  for insert with check (public.is_home_member(home_id) and status = 'pending');
grant update (status, result, payload, updated_at) on public.commands to authenticated;
create policy "controller updates commands" on public.commands
  for update using (home_id = public.controller_home()) with check (home_id = public.controller_home());

-- ---------------------------------------------------------------------------
-- Customer functions

-- Link a controller to a new home for the signed-in customer, using the code
-- the controller shows.
create function public.claim_controller(p_code text, p_home_name text default 'My home')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_controller controllers;
  v_home uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if exists (select 1 from controllers where auth_user_id = auth.uid()) then
    raise exception 'Controllers cannot claim controllers';
  end if;

  select * into v_controller from controllers
    where replace(claim_code, '-', '') = v_code and home_id is null
    for update;
  if not found then
    raise exception 'That code doesn''t match a controller waiting to be set up';
  end if;

  insert into homes (name) values (coalesce(nullif(trim(p_home_name), ''), 'My home'))
    returning id into v_home;
  insert into home_members (home_id, user_id, role) values (v_home, auth.uid(), 'owner');
  update controllers set home_id = v_home, claim_code = null, claimed_at = now()
    where id = v_controller.id;

  return v_home;
end;
$$;

-- Replace one zone's schedule for a day-by-day editor
create function public.set_zone_schedule(p_zone uuid, p_slots jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_home uuid;
begin
  select home_id into v_home from zones where id = p_zone;
  if v_home is null or not public.is_home_member(v_home) then
    raise exception 'Zone not found';
  end if;

  delete from schedule_slots where zone_id = p_zone;
  insert into schedule_slots (home_id, zone_id, day, on_time, off_time, temp)
    select v_home, p_zone, (s->>'day')::smallint, (s->>'on_time')::time, (s->>'off_time')::time, (s->>'temp')::numeric
    from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) s;
end;
$$;

-- Name a sensor and put it in a zone (also names sensors that report but
-- haven't been set up yet)
create function public.save_sensor(p_home uuid, p_device text, p_name text, p_zone uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_home_member(p_home) then
    raise exception 'Home not found';
  end if;
  if p_zone is not null and not exists (select 1 from zones where id = p_zone and home_id = p_home) then
    raise exception 'Zone not found';
  end if;

  insert into sensors (home_id, device_id, name, zone_id)
    values (p_home, p_device, trim(p_name), p_zone)
    on conflict (home_id, device_id) do update set name = excluded.name, zone_id = excluded.zone_id;
end;
$$;

create function public.remove_sensor(p_home uuid, p_device text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_home_member(p_home) then
    raise exception 'Home not found';
  end if;
  delete from sensors where home_id = p_home and device_id = p_device;
end;
$$;

-- ---------------------------------------------------------------------------
-- Controller functions

-- The controller's own record: whether it has been claimed yet, and its code
create function public.controller_status()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('controller_id', id, 'home_id', home_id, 'claim_code', claim_code)
  from controllers where auth_user_id = auth.uid();
$$;

-- Called every few seconds by the controller. It reports its state and gets
-- back the configuration it should apply. The first sync after a claim copies
-- the controller's existing zones, schedule and sensors into the cloud.
--
-- p_report: {
--   software_version,
--   zones: [{local_id, name, is_enabled, is_on, desired_temp, current_temp}],
--   schedule: [{zone_local_id, day, on_time, off_time, temp}],
--   sensors: [{device_id, name, zone_local_id}],
--   sensor_states: [{device_id, last_temp, last_battery, last_seen_at}]
-- }
create function public.controller_sync(p_report jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_controller controllers;
  v_home uuid;
  v_imported boolean := false;
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

  update sensors sn set
    last_temp = (s->>'last_temp')::numeric,
    last_battery = (s->>'last_battery')::int,
    last_seen_at = (s->>'last_seen_at')::timestamptz
  from jsonb_array_elements(coalesce(p_report->'sensor_states', '[]'::jsonb)) s
  where sn.home_id = v_home and sn.device_id = s->>'device_id';

  -- what the controller should apply
  return jsonb_build_object(
    'claimed', true,
    'home_id', v_home,
    'imported', v_imported,
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object('local_id', local_id, 'name', name, 'is_enabled', is_enabled,
                                          'boost_until', boost_until) order by local_id)
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

-- A sensor the controller has just paired
create function public.controller_add_sensor(p_device text, p_name text, p_zone_local_id int)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_home uuid := public.controller_home();
begin
  if v_home is null then
    raise exception 'Not a claimed controller';
  end if;
  insert into sensors (home_id, device_id, name, zone_id)
    values (v_home, p_device, left(trim(p_name), 20),
            (select id from zones where home_id = v_home and local_id = p_zone_local_id))
    on conflict (home_id, device_id) do update set name = excluded.name, zone_id = excluded.zone_id;
end;
$$;

-- Functions are callable only by signed-in users; each checks who is calling
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
