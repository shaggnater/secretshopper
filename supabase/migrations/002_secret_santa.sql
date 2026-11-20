-- =====================================================================
-- SecretShopper — Bonus Gift (Secret Santa)
--   1. Everyone votes on a spend limit (votes are private).
--   2. Once everyone has voted (or an admin closes voting) the most-voted
--      amount wins; ties go to the lower amount.
--   3. Everyone adds 3 Secret Santa ideas within the limit.
--   4. The randomizer pairs people up (everyone gives one, gets one, never
--      themselves) and picks one of the recipient's ideas at random.
--      It stays locked until EVERY member has added 3 ideas.
--      Each giver can see only their own match.
-- =====================================================================

alter table public.items add column if not exists santa boolean not null default false;

create table if not exists public.santa (
  household_id uuid primary key references public.households(id) on delete cascade,
  spend_limit  numeric(10,2),
  closed_at    timestamptz,
  drawn_at     timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists public.santa_votes (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  amount       numeric(10,2) not null check (amount > 0 and amount <= 10000),
  voted_at     timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.santa_assignments (
  household_id uuid not null references public.households(id) on delete cascade,
  giver        uuid not null references auth.users(id) on delete cascade,
  recipient    uuid not null references auth.users(id) on delete cascade,
  item_id      uuid references public.items(id) on delete set null,
  revealed_at  timestamptz,
  primary key (household_id, giver)
);

alter table public.santa             enable row level security;
alter table public.santa_votes       enable row level security;
alter table public.santa_assignments enable row level security;

-- Read-only from the app; all changes go through the functions below.
drop policy if exists santa_select on public.santa;
create policy santa_select on public.santa for select using (public.is_member(household_id));
drop policy if exists sv_select on public.santa_votes;
create policy sv_select on public.santa_votes for select using (user_id = auth.uid());          -- only your own vote
drop policy if exists sa_select on public.santa_assignments;
create policy sa_select on public.santa_assignments for select using (giver = auth.uid());     -- only your own match

-- ---------- internal: pick the winning amount and close voting ----------
create or replace function public.santa_finish_voting(hh uuid)
returns void language plpgsql security definer set search_path = public as $$
declare win numeric;
begin
  select amount into win from santa_votes where household_id = hh
    group by amount order by count(*) desc, amount asc limit 1;
  if win is null then raise exception 'Nobody has voted yet'; end if;
  update santa set spend_limit = win, closed_at = now() where household_id = hh;
end $$;
revoke execute on function public.santa_finish_voting(uuid) from public, anon, authenticated;

-- ---------- everything the Bonus Gift tab needs, in one call ----------
create or replace function public.santa_state(hh uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s santa; a santa_assignments; me uuid := auth.uid();
begin
  if not is_member(hh) then raise exception 'Not a member of this household'; end if;
  select * into s from santa where household_id = hh;
  select * into a from santa_assignments where household_id = hh and giver = me;
  return jsonb_build_object(
    'spend_limit', s.spend_limit,
    'closed',      s.closed_at is not null,
    'drawn',       s.drawn_at  is not null,
    'members',     (select count(*) from members where household_id = hh),
    'voted',       (select count(*) from santa_votes v
                      where v.household_id = hh
                        and exists (select 1 from members m where m.household_id = hh and m.user_id = v.user_id)),
    'my_vote',     (select amount from santa_votes where household_id = hh and user_id = me),
    'tally',       case when s.closed_at is not null then
                     (select coalesce(jsonb_agg(jsonb_build_object('amount', amount, 'count', c) order by amount), '[]'::jsonb)
                        from (select amount, count(*) c from santa_votes where household_id = hh group by amount) t)
                   end,
    'ready',       (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id,
                      'items', (select count(*) from items i where i.household_id = hh and i.owner_id = m.user_id and i.santa))), '[]'::jsonb)
                      from members m where m.household_id = hh),
    'participants',(select count(*) from santa_assignments where household_id = hh),
    'spun',        (select count(*) from santa_assignments where household_id = hh and revealed_at is not null),
    'in_draw',     a.giver is not null,
    'mine',        case when a.revealed_at is not null then
                     jsonb_build_object('recipient', a.recipient,
                       'item', (select to_jsonb(i) - 'household_id' from items i where i.id = a.item_id))
                   end
  );
end $$;

-- ---------- vote (or change your vote) ----------
create or replace function public.santa_vote(hh uuid, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
declare total int; voted int;
begin
  if not is_member(hh) then raise exception 'Not a member of this household'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000 then raise exception 'Pick an amount between $1 and $10,000'; end if;
  insert into santa (household_id) values (hh) on conflict do nothing;
  perform 1 from santa where household_id = hh for update;
  if exists (select 1 from santa where household_id = hh and closed_at is not null) then
    raise exception 'Voting is already closed';
  end if;
  insert into santa_votes (household_id, user_id, amount) values (hh, auth.uid(), round(p_amount, 2))
    on conflict (household_id, user_id) do update set amount = excluded.amount, voted_at = now();
  select count(*) into total from members where household_id = hh;
  select count(*) into voted from santa_votes v
    where v.household_id = hh and exists (select 1 from members m where m.household_id = hh and m.user_id = v.user_id);
  if voted >= total then perform santa_finish_voting(hh); end if;
end $$;

-- ---------- admin: close voting early ----------
create or replace function public.santa_close_voting(hh uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(hh) then raise exception 'Only household admins can do that'; end if;
  perform 1 from santa where household_id = hh and closed_at is null for update;
  if not found then raise exception 'Voting is already closed'; end if;
  perform santa_finish_voting(hh);
end $$;

-- ---------- the randomizer ----------
-- First spin of the year makes the whole draw; every spin reveals only YOUR match.
create or replace function public.santa_spin(hh uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s santa; me uuid := auth.uid(); parts uuid[]; n int; k int; pick uuid; all_ready boolean;
begin
  if not is_member(hh) then raise exception 'Not a member of this household'; end if;
  select * into s from santa where household_id = hh for update;
  if s.closed_at is null then raise exception 'Voting isn''t finished yet'; end if;

  if s.drawn_at is null then
    select coalesce(bool_and(cnt >= 3), false) into all_ready from (
      select (select count(*) from items i where i.household_id = hh and i.owner_id = m.user_id and i.santa) cnt
      from members m where m.household_id = hh) t;
    if not all_ready then   -- locked until EVERY member has 3 ideas, no exceptions
      raise exception 'Waiting for everyone to add their 3 ideas';
    end if;
    -- every member takes part, in random order
    select array_agg(m.user_id order by random()) into parts from members m
      where m.household_id = hh
        and exists (select 1 from items i where i.household_id = hh and i.owner_id = m.user_id and i.santa);
    n := coalesce(array_length(parts, 1), 0);
    if n < 2 then raise exception 'At least 2 people need Secret Santa ideas for a draw'; end if;
    -- person k gives to person k+1 (last gives to first): nobody gets themselves or two people
    for k in 1..n loop
      select id into pick from items
        where household_id = hh and owner_id = parts[(k % n) + 1] and santa order by random() limit 1;
      insert into santa_assignments (household_id, giver, recipient, item_id)
        values (hh, parts[k], parts[(k % n) + 1], pick);
    end loop;
    update santa set drawn_at = now() where household_id = hh;
  end if;

  update santa_assignments set revealed_at = coalesce(revealed_at, now())
    where household_id = hh and giver = me;
  if not found then raise exception 'You weren''t in this year''s draw because you hadn''t added any ideas'; end if;
  return santa_state(hh) -> 'mine';
end $$;

-- ---------- admin: start over (next year) ----------
create or replace function public.santa_reset(hh uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(hh) then raise exception 'Only household admins can do that'; end if;
  delete from santa_assignments where household_id = hh;
  delete from santa_votes       where household_id = hh;
  delete from santa             where household_id = hh;
  delete from items             where household_id = hh and santa;
end $$;

revoke execute on function public.santa_state(uuid)              from public, anon;
revoke execute on function public.santa_vote(uuid, numeric)      from public, anon;
revoke execute on function public.santa_close_voting(uuid)       from public, anon;
revoke execute on function public.santa_spin(uuid)               from public, anon;
revoke execute on function public.santa_reset(uuid)              from public, anon;
grant  execute on function public.santa_state(uuid)              to authenticated;
grant  execute on function public.santa_vote(uuid, numeric)      to authenticated;
grant  execute on function public.santa_close_voting(uuid)       to authenticated;
grant  execute on function public.santa_spin(uuid)               to authenticated;
grant  execute on function public.santa_reset(uuid)              to authenticated;
