-- Budget notices follow the current plan. A new budget notice replaces any
-- earlier one still showing, and the controller can withdraw them when the
-- plan no longer needs one; before, a notice stayed until someone dismissed
-- it, even after the plan had changed. The controller decides when a plan
-- has changed enough to say so (energy/budget.js).

create or replace function public.controller_notify(p_kind text, p_title text, p_body text, p_zone_local_ids int[])
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_home uuid := public.controller_home();
  v_id uuid;
begin
  if v_home is null then
    raise exception 'Not a claimed controller';
  end if;
  if p_kind like 'budget%' then
    -- the same notice is already showing
    if exists (select 1 from notifications where home_id = v_home and kind = p_kind and body = left(p_body, 1000) and dismissed_at is null) then
      return null;
    end if;
    update notifications set dismissed_at = now()
      where home_id = v_home and kind like 'budget%' and dismissed_at is null;
  elsif exists (select 1 from notifications where home_id = v_home and kind = p_kind and created_at > now() - interval '7 days') then
    return null;
  end if;
  insert into notifications (home_id, kind, title, body, action)
    values (v_home, p_kind, left(p_title, 200), left(p_body, 1000), jsonb_build_object('zone_local_ids', to_jsonb(coalesce(p_zone_local_ids, '{}'))))
    returning id into v_id;
  return v_id;
end;
$$;

-- The plan no longer needs a budget notice: take down any still showing
create or replace function public.controller_withdraw_budget_notices()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_home uuid := public.controller_home();
  v_count integer;
begin
  if v_home is null then
    raise exception 'Not a claimed controller';
  end if;
  update notifications set dismissed_at = now()
    where home_id = v_home and kind like 'budget%' and dismissed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.controller_withdraw_budget_notices() from public, anon;
grant execute on function public.controller_withdraw_budget_notices() to authenticated;
