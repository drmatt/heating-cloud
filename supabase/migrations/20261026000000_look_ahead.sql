-- Look-ahead heating. Each zone says what heats it (asked at set-up), so a
-- new controller can plan before it has learned anything. With eco on, a
-- zone is warm when its rooms are used, at its comfort temperature, and the
-- controller reports its plan: when it will next start heating, where the
-- warm periods come from, and how slowly the zone responds.

alter table public.zones
  add column heater text check (heater in ('radiators', 'underfloor', 'unknown')),   -- null: not asked yet
  add column comfort_temp numeric(4,1) check (comfort_temp between 10 and 25),
  add column plan jsonb;                                                   -- reported by the controller

grant update (heater, comfort_temp) on public.zones to authenticated;

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
    plan = case when z ? 'plan' then z->'plan' else zn.plan end,
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
                                          'comfort_margin', comfort_margin, 'min_temp', min_temp,
                                          'heater', heater, 'comfort_temp', comfort_temp) order by local_id)
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
