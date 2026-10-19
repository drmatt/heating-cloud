-- The gas bill for each billing month, split into the standing charge, each
-- zone's heating, hot water and other gas, with the current month's
-- projection. Written by the controller.

create table public.cost_breakdowns (
  home_id uuid not null references public.homes(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  is_current boolean not null default false,
  items jsonb not null,             -- [{ key, zone_local_id, name, actual_pence, projected_pence }]
  actual_pence integer not null,
  projected_pence integer not null,
  days_counted integer not null,
  estimated_days integer not null,
  updated_at timestamptz not null default now(),
  primary key (home_id, period_start)
);

alter table public.cost_breakdowns enable row level security;
revoke all on public.cost_breakdowns from anon, authenticated;
grant select, insert, update, delete on public.cost_breakdowns to authenticated;

create policy "read cost breakdowns" on public.cost_breakdowns
  for select using (public.can_access_home(home_id));
create policy "controller adds cost breakdowns" on public.cost_breakdowns
  for insert with check (home_id = public.controller_home());
create policy "controller updates cost breakdowns" on public.cost_breakdowns
  for update using (home_id = public.controller_home()) with check (home_id = public.controller_home());
-- a change of billing day re-cuts the months, so the controller replaces them
create policy "controller removes cost breakdowns" on public.cost_breakdowns
  for delete using (home_id = public.controller_home());
