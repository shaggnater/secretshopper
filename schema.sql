-- =====================================================================
-- SecretShopper — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
--
-- The secrecy rule lives HERE, in the database, not in the web page:
--   * item_status (claimed / purchased) and comments (secret notes) are
--     readable by every household member EXCEPT the owner of that item.
--   * Even if someone opens dev tools and queries the API directly,
--     Postgres Row Level Security returns nothing for their own items.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tables ---------------------------------------------------

create table if not exists public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique
              default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  role         text not null default 'member' check (role in ('admin', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.items (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 200),
  url          text check (url is null or url ~* '^https?://'),
  image_url    text check (image_url is null or image_url ~* '^https?://'),
  price        numeric(10,2) check (price is null or price >= 0),
  qty          int  not null default 1 check (qty between 1 and 99),
  notes        text check (notes is null or char_length(notes) <= 500),
  priority     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists items_household_owner_idx on public.items (household_id, owner_id);

-- One row per item at most: whoever claims it first "has" it.
create table if not exists public.item_status (
  item_id    uuid primary key references public.items(id) on delete cascade,
  status     text not null check (status in ('claimed', 'purchased')),
  by_user    uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now()
);

-- Secret notes on an item ("I'll split this with you", "got the blue one")
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.items(id) on delete cascade,
  author_id  uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists comments_item_idx on public.comments (item_id);

-- ---------- Helper functions (bypass RLS safely) ---------------------

create or replace function public.is_member(hh uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = hh and user_id = auth.uid());
$$;

create or replace function public.is_admin(hh uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members
                 where household_id = hh and user_id = auth.uid() and role = 'admin');
$$;

-- TRUE when the viewer is in the item's household AND is not the item's owner.
create or replace function public.can_see_secrets(item uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from items i
    join members m on m.household_id = i.household_id
    where i.id = item
      and m.user_id = auth.uid()
      and i.owner_id <> auth.uid()
  );
$$;

-- ---------- Row Level Security ---------------------------------------

alter table public.households  enable row level security;
alter table public.members     enable row level security;
alter table public.items       enable row level security;
alter table public.item_status enable row level security;
alter table public.comments    enable row level security;

-- households: members can see; admins can rename. Creation goes through create_household().
drop policy if exists hh_select on public.households;
create policy hh_select on public.households for select using (public.is_member(id));
drop policy if exists hh_update on public.households;
create policy hh_update on public.households for update
  using (public.is_admin(id)) with check (public.is_admin(id));

-- members: see your household; edit only your own display name; leave, or admin removes.
drop policy if exists mem_select on public.members;
create policy mem_select on public.members for select using (public.is_member(household_id));
drop policy if exists mem_update on public.members;
create policy mem_update on public.members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists mem_delete on public.members;
create policy mem_delete on public.members for delete
  using (user_id = auth.uid() or public.is_admin(household_id));
-- Only the display_name column is updatable (nobody can promote themselves to admin).
revoke update on public.members from authenticated, anon;
grant  update (display_name) on public.members to authenticated;

-- items: whole household can see every list; you only add/edit/delete your own.
drop policy if exists items_select on public.items;
create policy items_select on public.items for select using (public.is_member(household_id));
drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert
  with check (owner_id = auth.uid() and public.is_member(household_id));
drop policy if exists items_update on public.items;
create policy items_update on public.items for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and public.is_member(household_id));
drop policy if exists items_delete on public.items;
create policy items_delete on public.items for delete using (owner_id = auth.uid());

-- item_status: THE SECRET. Invisible to the item's owner.
drop policy if exists st_select on public.item_status;
create policy st_select on public.item_status for select using (public.can_see_secrets(item_id));
drop policy if exists st_insert on public.item_status;
create policy st_insert on public.item_status for insert
  with check (by_user = auth.uid() and public.can_see_secrets(item_id));
drop policy if exists st_update on public.item_status;
create policy st_update on public.item_status for update
  using (by_user = auth.uid())
  with check (by_user = auth.uid() and public.can_see_secrets(item_id));
drop policy if exists st_delete on public.item_status;
create policy st_delete on public.item_status for delete using (by_user = auth.uid());

-- comments: also invisible to the item's owner.
drop policy if exists cm_select on public.comments;
create policy cm_select on public.comments for select using (public.can_see_secrets(item_id));
drop policy if exists cm_insert on public.comments;
create policy cm_insert on public.comments for insert
  with check (author_id = auth.uid() and public.can_see_secrets(item_id));
drop policy if exists cm_delete on public.comments;
create policy cm_delete on public.comments for delete using (author_id = auth.uid());

-- ---------- RPCs: create / join / reset invite -----------------------

create or replace function public.create_household(p_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into households (name, created_by) values (trim(p_name), auth.uid())
    returning id into hid;
  insert into members (household_id, user_id, display_name, role)
    values (hid, auth.uid(), trim(p_display_name), 'admin');
  return hid;
end $$;

create or replace function public.join_household(p_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into hid from households where invite_code = upper(trim(p_code));
  if hid is null then raise exception 'That invite code was not found'; end if;
  insert into members (household_id, user_id, display_name, role)
    values (hid, auth.uid(), trim(p_display_name), 'member')
    on conflict (household_id, user_id) do nothing;
  return hid;
end $$;

create or replace function public.reset_invite_code(hh uuid)
returns text language plpgsql security definer set search_path = public as $$
declare code text;
begin
  if not public.is_admin(hh) then raise exception 'Only household admins can do that'; end if;
  code := upper(substr(md5(gen_random_uuid()::text), 1, 8));
  update households set invite_code = code where id = hh;
  return code;
end $$;

revoke execute on function public.create_household(text, text)  from public, anon;
revoke execute on function public.join_household(text, text)    from public, anon;
revoke execute on function public.reset_invite_code(uuid)       from public, anon;
grant  execute on function public.create_household(text, text)  to authenticated;
grant  execute on function public.join_household(text, text)    to authenticated;
grant  execute on function public.reset_invite_code(uuid)       to authenticated;

-- ---------- Realtime -------------------------------------------------
-- Only lists and members stream live. item_status and comments are
-- deliberately NOT added: Supabase sends DELETE events without RLS
-- filtering, which could tip off an owner that one of their items had
-- been claimed. The app polls those two tables every 15 seconds instead.
do $$
begin
  begin alter publication supabase_realtime add table public.items;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
end $$;
