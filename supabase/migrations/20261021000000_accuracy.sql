-- Predictions scored against reality, the history of every fitted model, and
-- a summary of how accurate the controller has been, so modelling can be
-- measured and improved.

create table public.predictions (
  home_id uuid not null references public.homes(id) on delete cascade,
  local_id integer not null,                -- the controller's own id for the prediction
  made_at timestamptz not null,
  kind text not null,                       -- gas_kwh_day, cost_pence_day, zone_hours_day, outdoor_mean_day, room_temp_60, room_peak_2h, month_cost
  subject text not null,                    -- 'home', a zone's local id, or a billing period
  target_time timestamptz not null,
  target_end timestamptz,
  value numeric(10,3) not null,
  actual numeric(10,3),
  context jsonb,
  model_version text,
  primary key (home_id, local_id)
);

create index predictions_home_kind on public.predictions (home_id, kind, target_time desc);

create table public.model_history (
  home_id uuid not null references public.homes(id) on delete cascade,
  local_id integer not null,
  fitted_at timestamptz not null,
  kind text not null,                       -- zone_thermal, usage, thresholds, degree_hours
  subject text not null,
  model jsonb not null,
  primary key (home_id, local_id)
);

create table public.model_accuracy (
  home_id uuid primary key references public.homes(id) on delete cascade,
  computed_at timestamptz not null,
  summary jsonb not null                    -- per kind: count, mean error, bias, and the corrections in use
);

do $$
declare t text;
begin
  foreach t in array array['predictions', 'model_history', 'model_accuracy'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('create policy "read %1$s" on public.%1$I for select using (public.can_access_home(home_id))', t);
    execute format('create policy "controller adds %1$s" on public.%1$I for insert with check (home_id = public.controller_home())', t);
    execute format('create policy "controller updates %1$s" on public.%1$I for update using (home_id = public.controller_home()) with check (home_id = public.controller_home())', t);
  end loop;
end $$;
