-- Sharing a home: the owner invites someone by email; when they sign in with
-- that email they can join and control the heating as a member. Only owners
-- manage who has access.

create table public.home_invites (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes(id) on delete cascade,
  email text not null check (email = lower(email) and email like '%@%'),
  invited_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (home_id, email)
);

alter table public.home_invites enable row level security;
revoke all on public.home_invites from anon, authenticated;
grant select on public.home_invites to authenticated;

create function public.is_home_owner(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from home_members where home_id = h and user_id = auth.uid() and role = 'owner');
$$;

create policy "owners and the invited person read invites" on public.home_invites
  for select using (public.is_home_owner(home_id) or email = lower(auth.email()));

-- Invite someone by email (owners only)
create function public.invite_member(p_home uuid, p_email text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
begin
  if not public.is_home_owner(p_home) then
    raise exception 'Only the owner can invite people';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter an email address';
  end if;
  if exists (select 1 from home_members m join auth.users u on u.id = m.user_id where m.home_id = p_home and lower(u.email) = v_email) then
    raise exception 'They already have access';
  end if;
  insert into home_invites (home_id, email) values (p_home, v_email)
    on conflict (home_id, email) do update set created_at = now(), accepted_at = null, invited_by = auth.uid();
end;
$$;

-- Join a home you've been invited to
create function public.accept_invite(p_invite uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_invite home_invites;
begin
  select * into v_invite from home_invites where id = p_invite and accepted_at is null;
  if not found or v_invite.email <> lower(auth.email()) then
    raise exception 'That invitation isn''t for this account';
  end if;
  insert into home_members (home_id, user_id, role) values (v_invite.home_id, auth.uid(), 'member')
    on conflict (home_id, user_id) do nothing;
  update home_invites set accepted_at = now() where id = p_invite;
  return v_invite.home_id;
end;
$$;

-- Invitations waiting for the signed-in person, with the home's name
create function public.my_invites()
returns table (id uuid, home_name text, invited_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, h.name, i.created_at
  from home_invites i join homes h on h.id = i.home_id
  where i.email = lower(auth.email()) and i.accepted_at is null
  order by i.created_at desc;
$$;

-- Who has access, with emails (for members of the home)
create function public.home_people(p_home uuid)
returns table (user_id uuid, email text, role text, is_you boolean, invited boolean, invite_id uuid)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.user_id = auth.uid(), false, null::uuid
  from home_members m join auth.users u on u.id = m.user_id
  where m.home_id = p_home and public.is_home_member(p_home)
  union all
  select null, i.email, 'invited', false, true, i.id
  from home_invites i
  where i.home_id = p_home and i.accepted_at is null and public.is_home_member(p_home);
$$;

-- Remove someone's access, or cancel an invitation (owners only; an owner
-- can't remove themselves, so a home always has an owner)
create function public.remove_member(p_home uuid, p_user uuid, p_invite uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_home_owner(p_home) then
    raise exception 'Only the owner can change who has access';
  end if;
  if p_user = auth.uid() then
    raise exception 'You can''t remove yourself';
  end if;
  if p_user is not null then
    delete from home_members where home_id = p_home and user_id = p_user and role <> 'owner';
  end if;
  if p_invite is not null then
    delete from home_invites where home_id = p_home and id = p_invite;
  end if;
end;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
