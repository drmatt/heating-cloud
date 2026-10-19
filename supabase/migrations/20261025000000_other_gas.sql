-- Whether the home uses gas for anything besides heating and hot water
-- (cooking, a gas fire). When it doesn't, the controller's cost model puts
-- all gas down to heating and hot water.

alter table public.budgets add column other_gas boolean not null default true;
