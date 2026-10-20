-- Inputs for the dashboard's "what if" planner: the budget forecast's model
-- and weather for the rest of the billing month, and typical weather by
-- month, so the browser can price other heating settings instantly. Written
-- by the controller about once an hour; one row per home.

create table public.what_if (
  home_id uuid primary key references public.homes(id) on delete cascade,
  kit jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.what_if enable row level security;
revoke all on public.what_if from anon, authenticated;
grant select, insert, update on public.what_if to authenticated;

create policy "read what if" on public.what_if
  for select using (public.can_access_home(home_id));
create policy "controller adds what if" on public.what_if
  for insert with check (home_id = public.controller_home());
create policy "controller updates what if" on public.what_if
  for update using (home_id = public.controller_home()) with check (home_id = public.controller_home());
