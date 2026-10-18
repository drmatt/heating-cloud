-- "Too hot" / "Too cold" feedback: a short-term nudge to the zone, and
-- labelled data the controller learns comfortable temperatures from.

create table public.comfort_feedback (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  user_id uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  zone_id uuid not null references public.zones(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete set null,
  feeling text not null check (feeling in ('cold', 'hot')),
  room_temp numeric(4,1),            -- the zone's temperature when reported
  target_temp numeric(4,1),          -- what the controller was aiming for
  context jsonb not null default '{}'::jsonb   -- eco, budget offset, heating on, etc.
);

create index comfort_feedback_home on public.comfort_feedback (home_id, created_at desc);

alter table public.comfort_feedback enable row level security;
revoke all on public.comfort_feedback from anon, authenticated;
grant select on public.comfort_feedback to authenticated;
create policy "read feedback" on public.comfort_feedback
  for select using (public.can_access_home(home_id));

alter table public.zones
  add column comfort_bump numeric(3,1) not null default 0,   -- short-term nudge, °C
  add column comfort_bump_until timestamptz,
  add column comfort_preferred numeric(4,1),                 -- learned by the controller
  add column comfort_reports integer not null default 0;     -- reports it learned from

-- Report that a zone (or a room in it) is too hot or too cold. Records the
-- feedback with the conditions, and nudges the zone by 1 °C for 2 hours
-- (repeat reports add up, to +/- 2 °C).
create function public.report_comfort(p_zone uuid, p_room uuid, p_feeling text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_zone zones;
  v_bump numeric;
begin
  select * into v_zone from zones where id = p_zone;
  if not found or not public.is_home_member(v_zone.home_id) then
    raise exception 'Zone not found';
  end if;
  if p_feeling not in ('cold', 'hot') then
    raise exception 'Say whether it is too hot or too cold';
  end if;
  if p_room is not null and not exists (select 1 from rooms where id = p_room and home_id = v_zone.home_id) then
    raise exception 'Room not found';
  end if;

  insert into comfort_feedback (home_id, zone_id, room_id, feeling, room_temp, target_temp, context)
  values (v_zone.home_id, p_zone, p_room, p_feeling, v_zone.current_temp, v_zone.desired_temp,
          jsonb_build_object('heating_on', v_zone.is_on, 'eco', v_zone.eco_enabled, 'comfort_margin', v_zone.comfort_margin,
                             'budget_offset', v_zone.budget_offset, 'enabled', v_zone.is_enabled,
                             'previous_bump', case when v_zone.comfort_bump_until > now() then v_zone.comfort_bump else 0 end));

  -- opposite feedback cancels an earlier nudge; the same feedback adds to it
  v_bump := case when v_zone.comfort_bump_until > now() then v_zone.comfort_bump else 0 end;
  v_bump := greatest(-2, least(2, v_bump + case when p_feeling = 'cold' then 1 else -1 end));
  update zones set comfort_bump = v_bump, comfort_bump_until = now() + interval '2 hours' where id = p_zone;

  return jsonb_build_object('bump', v_bump, 'until', now() + interval '2 hours',
                            'room_temp', v_zone.current_temp, 'target_temp', v_zone.desired_temp, 'enabled', v_zone.is_enabled);
end;
$$;

-- controller_sync: zones now carry the nudge, and take the learned
-- preference from the controller
create or replace function public.controller_report_comfort(p_prefs jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_home uuid := public.controller_home();
begin
  if v_home is null then
    raise exception 'Not a claimed controller';
  end if;
  update zones zn set
    comfort_preferred = (p->>'preferred')::numeric,
    comfort_reports = coalesce((p->>'reports')::int, 0)
  from jsonb_array_elements(coalesce(p_prefs, '[]'::jsonb)) p
  where zn.home_id = v_home and zn.local_id = (p->>'local_id')::int;
end;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
