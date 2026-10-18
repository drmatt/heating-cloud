-- Monthly budget: settings, gas use and costs from the controller (Octopus
-- meter readings), rooms and how they're used, the controller's budget plan,
-- and limits on the assistant.

-- ---------------------------------------------------------------------------
-- Budget settings

create table public.budgets (
  home_id uuid primary key references public.homes(id) on delete cascade,
  monthly_pence integer not null check (monthly_pence > 0),
  start_day smallint not null default 1 check (start_day between 1 and 28),  -- the billing day
  boiler_kw numeric(4,1) not null default 24 check (boiler_kw between 4 and 60),
  declined_suggestions text[] not null default '{}',                           -- suggestions the owner said no to this period
  updated_at timestamptz not null default now()
);

alter table public.budgets enable row level security;
revoke all on public.budgets from anon, authenticated;
grant select, insert, update on public.budgets to authenticated;

create policy "read budget" on public.budgets
  for select using (public.can_access_home(home_id));
create policy "members set budget" on public.budgets
  for insert with check (public.is_home_member(home_id));
create policy "members change budget" on public.budgets
  for update using (public.is_home_member(home_id)) with check (public.is_home_member(home_id));

-- Lowest temperature the budget may take each zone to
alter table public.zones
  add column min_temp numeric(4,1) not null default 16 check (min_temp between 5 and 25),
  add column budget_offset numeric(3,1) not null default 0;   -- reported by the controller

grant update (min_temp) on public.zones to authenticated;

-- ---------------------------------------------------------------------------
-- Gas use and costs, from the controller

create table public.energy_daily (
  home_id uuid not null references public.homes(id) on delete cascade,
  day date not null,
  kwh numeric(7,2) not null,
  cost_pence integer not null,
  metered boolean not null,          -- false while the day is estimated from boiler time
  primary key (home_id, day)
);

alter table public.energy_daily enable row level security;
revoke all on public.energy_daily from anon, authenticated;
grant select, insert, update on public.energy_daily to authenticated;

create policy "read energy" on public.energy_daily
  for select using (public.can_access_home(home_id));
create policy "controller adds energy" on public.energy_daily
  for insert with check (home_id = public.controller_home());
create policy "controller updates energy" on public.energy_daily
  for update using (home_id = public.controller_home()) with check (home_id = public.controller_home());

-- What the controller knows about the supply: tariff, meter, connection
create table public.energy_status (
  home_id uuid primary key references public.homes(id) on delete cascade,
  supplier text,
  tariff_code text,
  unit_rate_pence numeric(6,3),
  standing_pence numeric(6,2),
  meter_unit text,                   -- 'kWh' or 'm3', as detected
  last_reading_at timestamptz,
  connected boolean not null default false,
  error text,
  kwh_per_hour jsonb,                -- learned gas use per hour of heating, by zone
  updated_at timestamptz not null default now()
);

alter table public.energy_status enable row level security;
revoke all on public.energy_status from anon, authenticated;
grant select, insert, update on public.energy_status to authenticated;

create policy "read energy status" on public.energy_status
  for select using (public.can_access_home(home_id));
create policy "controller adds energy status" on public.energy_status
  for insert with check (home_id = public.controller_home());
create policy "controller updates energy status" on public.energy_status
  for update using (home_id = public.controller_home()) with check (home_id = public.controller_home());

-- ---------------------------------------------------------------------------
-- Rooms and how they're used

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  zone_id uuid references public.zones(id) on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  kind text not null default 'other'
    check (kind in ('living', 'kitchen', 'bedroom', 'spare', 'office', 'bathroom', 'hall', 'other')),
  has_trv boolean not null default true,
  -- 'often', 'sometimes' or 'rarely', plus the times it's usually in use:
  -- [{ "days": [1,2,3,4,5], "from": "18:00", "to": "23:00" }]
  usage text not null default 'often' check (usage in ('often', 'sometimes', 'rarely')),
  periods jsonb not null default '[]'::jsonb,
  notes text check (char_length(notes) <= 300),
  created_at timestamptz not null default now()
);

create index rooms_home on public.rooms (home_id);

alter table public.rooms enable row level security;
revoke all on public.rooms from anon, authenticated;
grant select, insert, update, delete on public.rooms to authenticated;

create policy "read rooms" on public.rooms
  for select using (public.can_access_home(home_id));
create policy "members add rooms" on public.rooms
  for insert with check (public.is_home_member(home_id)
    and (zone_id is null or exists (select 1 from public.zones z where z.id = zone_id and z.home_id = rooms.home_id)));
create policy "members change rooms" on public.rooms
  for update using (public.is_home_member(home_id))
  with check (public.is_home_member(home_id)
    and (zone_id is null or exists (select 1 from public.zones z where z.id = zone_id and z.home_id = rooms.home_id)));
create policy "members remove rooms" on public.rooms
  for delete using (public.is_home_member(home_id));

-- ---------------------------------------------------------------------------
-- The controller's budget plan, newest first

create table public.budget_plans (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  created_at timestamptz not null default now(),
  period_start date not null,
  period_end date not null,
  budget_pence integer not null,
  spent_pence integer not null,
  forecast_pence integer not null,             -- month end, with the plan
  forecast_without_plan_pence integer not null,
  achievable boolean not null,
  automatic jsonb not null default '[]'::jsonb,    -- changes the controller has made
  suggestions jsonb not null default '[]'::jsonb,  -- changes waiting for the owner
  trv_advice jsonb not null default '[]'::jsonb,
  estimated boolean not null default true          -- false once based on meter readings
);

create index budget_plans_home on public.budget_plans (home_id, created_at desc);

alter table public.budget_plans enable row level security;
revoke all on public.budget_plans from anon, authenticated;
grant select, insert on public.budget_plans to authenticated;

create policy "read plans" on public.budget_plans
  for select using (public.can_access_home(home_id));
create policy "controller adds plans" on public.budget_plans
  for insert with check (home_id = public.controller_home());

-- ---------------------------------------------------------------------------
-- Assistant use per home per day, written only by the assistant function

create table public.assistant_usage (
  home_id uuid not null references public.homes(id) on delete cascade,
  day date not null default current_date,
  calls integer not null default 0,
  primary key (home_id, day)
);

alter table public.assistant_usage enable row level security;
revoke all on public.assistant_usage from anon, authenticated;

-- ---------------------------------------------------------------------------
-- New command and notification kinds

alter table public.commands drop constraint commands_type_check;
alter table public.commands add constraint commands_type_check
  check (type in ('scan_sensors', 'pair_sensor', 'set_sensor_network', 'set_octopus'));

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('switch_on', 'switch_off', 'budget_at_risk', 'budget_unachievable', 'budget_suggestion'));

-- ---------------------------------------------------------------------------
-- controller_sync: also returns the budget, rooms and minimum temperatures,
-- and takes the budget offsets the controller has applied

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
    budget_offset = coalesce((z->>'budget_offset')::numeric, 0),
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
    'budget', (select to_jsonb(b) - 'home_id' from budgets b where b.home_id = v_home),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'kind', r.kind, 'has_trv', r.has_trv, 'usage', r.usage,
                                          'periods', r.periods, 'zone_local_id', zn.local_id) order by r.name)
      from rooms r left join zones zn on zn.id = r.zone_id where r.home_id = v_home), '[]'::jsonb),
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object('local_id', local_id, 'name', name, 'is_enabled', is_enabled,
                                          'boost_until', boost_until, 'eco_enabled', eco_enabled,
                                          'comfort_margin', comfort_margin, 'min_temp', min_temp) order by local_id)
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

-- controller_notify accepts the new kinds; budget notices repeat at most daily
create or replace function public.controller_notify(p_kind text, p_title text, p_body text, p_zone_local_ids int[])
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_home uuid := public.controller_home();
  v_id uuid;
  v_gap interval := case when p_kind like 'budget%' then interval '1 day' else interval '7 days' end;
begin
  if v_home is null then
    raise exception 'Not a claimed controller';
  end if;
  if exists (select 1 from notifications where home_id = v_home and kind = p_kind and created_at > now() - v_gap) then
    return null;
  end if;
  insert into notifications (home_id, kind, title, body, action)
    values (v_home, p_kind, left(p_title, 200), left(p_body, 1000), jsonb_build_object('zone_local_ids', to_jsonb(coalesce(p_zone_local_ids, '{}'))))
    returning id into v_id;
  return v_id;
end;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
