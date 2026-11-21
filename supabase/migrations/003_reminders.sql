-- =====================================================================
-- SecretShopper — email reminders
--   * Each person can turn on emails about gifts they've CLAIMED but not
--     marked purchased (off by default; choices picked in the app).
--   * Includes your Secret Santa gift once you've spun and seen your match,
--     until you mark it bought.
--   * A daily job (10am Eastern) calls the send-reminders Edge Function,
--     which decides who's due based on each person's choices.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------- 1. per-person reminder choices ----------
create table if not exists public.reminder_prefs (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  enabled       boolean not null default false,
  frequency     text not null default 'weekly' check (frequency in ('daily', 'every3', 'weekly', 'countdown')),
  min_age_days  int not null default 2 check (min_age_days between 0 and 14),
  include_santa boolean not null default true,
  last_sent_at  timestamptz,
  last_test_at  timestamptz,
  updated_at    timestamptz not null default now()
);
alter table public.reminder_prefs enable row level security;
drop policy if exists rp_select on public.reminder_prefs;
create policy rp_select on public.reminder_prefs for select using (user_id = auth.uid());
drop policy if exists rp_insert on public.reminder_prefs;
create policy rp_insert on public.reminder_prefs for insert with check (user_id = auth.uid());
drop policy if exists rp_update on public.reminder_prefs;
create policy rp_update on public.reminder_prefs for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- people can change their choices, but not the "last sent" bookkeeping
revoke update on public.reminder_prefs from authenticated, anon;
grant  update (enabled, frequency, min_age_days, include_santa, updated_at) on public.reminder_prefs to authenticated;

-- ---------- 2. Secret Santa: mark your gift bought ----------
alter table public.santa_assignments add column if not exists purchased_at timestamptz;

create or replace function public.santa_mark_bought(hh uuid, p_bought boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update santa_assignments set purchased_at = case when p_bought then now() end
    where household_id = hh and giver = auth.uid() and revealed_at is not null;
  if not found then raise exception 'Spin the randomizer first'; end if;
end $$;
revoke execute on function public.santa_mark_bought(uuid, boolean) from public, anon;
grant  execute on function public.santa_mark_bought(uuid, boolean) to authenticated;

-- santa_state now also says whether you've bought your Secret Santa gift
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
                     jsonb_build_object('recipient', a.recipient, 'purchased', a.purchased_at is not null,
                       'item', (select to_jsonb(i) - 'household_id' from items i where i.id = a.item_id))
                   end
  );
end $$;

-- ---------- 3. a private secret the daily job uses to call the function ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.app_settings (key text primary key, value text not null);
insert into private.app_settings (key, value)
  values ('reminder_secret', encode(extensions.gen_random_bytes(24), 'hex'))
  on conflict (key) do nothing;

create or replace function public.reminder_check_secret(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from private.app_settings where key = 'reminder_secret' and value = p);
$$;

-- ---------- 4. who's due, and what to remind them about ----------
-- p_user / p_force are used for the "send me a test email" button.
create or replace function public.reminder_batch(p_user uuid default null, p_force boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ny timestamp := now() at time zone 'America/New_York'; result jsonb;
begin
  with due as (
    select p.* from reminder_prefs p
    where (case when p_user is null then p.enabled else p.user_id = p_user end)
      and (p_force or p.last_sent_at is null or now() - p.last_sent_at >=
            case p.frequency
              when 'daily'  then interval '20 hours'
              when 'every3' then interval '68 hours'
              when 'weekly' then interval '164 hours'
              else  -- countdown: weekly, then every 3 days from Dec 10, then daily Dec 18-24
                case when ny >= make_timestamp(extract(year from ny)::int, 12, 18, 0, 0, 0)
                       and ny <  make_timestamp(extract(year from ny)::int, 12, 25, 0, 0, 0) then interval '20 hours'
                     when ny >= make_timestamp(extract(year from ny)::int, 12, 10, 0, 0, 0)
                       and ny <  make_timestamp(extract(year from ny)::int, 12, 25, 0, 0, 0) then interval '68 hours'
                     else interval '164 hours' end
            end)
  ),
  claims as (
    select s.by_user as uid,
           jsonb_agg(jsonb_build_object('title', i.title, 'url', i.url, 'price', i.price, 'qty', i.qty,
                     'image', i.image_url, 'for', m.display_name, 'household', h.name, 'claimed_at', s.updated_at)
                     order by h.name, m.display_name, i.title) as items
    from item_status s
    join due d       on d.user_id = s.by_user
    join items i     on i.id = s.item_id
    join members m   on m.household_id = i.household_id and m.user_id = i.owner_id
    join households h on h.id = i.household_id
    where s.status = 'claimed'
      and (p_force or s.updated_at < now() - make_interval(days => d.min_age_days))
      and exists (select 1 from members mm where mm.household_id = i.household_id and mm.user_id = s.by_user)
    group by s.by_user
  ),
  santas as (
    select a.giver as uid,
           jsonb_agg(jsonb_build_object('for', m.display_name, 'household', h.name, 'limit', sa.spend_limit,
                     'title', i.title, 'url', i.url, 'price', i.price, 'image', i.image_url)) as items
    from santa_assignments a
    join due d        on d.user_id = a.giver and d.include_santa
    join members m    on m.household_id = a.household_id and m.user_id = a.recipient
    join households h on h.id = a.household_id
    left join santa sa on sa.household_id = a.household_id
    left join items i  on i.id = a.item_id
    where a.revealed_at is not null and a.purchased_at is null
    group by a.giver
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', d.user_id,
           'email',   u.email,
           'name',    (select display_name from members where user_id = d.user_id order by joined_at limit 1),
           'claims',  coalesce(c.items, '[]'::jsonb),
           'santa',   coalesce(sn.items, '[]'::jsonb))), '[]'::jsonb)
    into result
  from due d
  join auth.users u on u.id = d.user_id
  left join claims c  on c.uid = d.user_id
  left join santas sn on sn.uid = d.user_id
  where u.email is not null and (p_user is not null or c.items is not null or sn.items is not null);
  return result;
end $$;

create or replace function public.reminder_mark_sent(p_users uuid[], p_test boolean default false)
returns void language sql security definer set search_path = public as $$
  update reminder_prefs set last_sent_at = case when p_test then last_sent_at else now() end,
                            last_test_at = case when p_test then now() else last_test_at end
  where user_id = any (p_users);
$$;

-- only the Edge Function (service role) may call these three
revoke execute on function public.reminder_check_secret(text)        from public, anon, authenticated;
revoke execute on function public.reminder_batch(uuid, boolean)      from public, anon, authenticated;
revoke execute on function public.reminder_mark_sent(uuid[], boolean) from public, anon, authenticated;
grant  execute on function public.reminder_check_secret(text)        to service_role;
grant  execute on function public.reminder_batch(uuid, boolean)      to service_role;
grant  execute on function public.reminder_mark_sent(uuid[], boolean) to service_role;

-- ---------- 5. run every day at 10am Eastern (15:00 UTC) ----------
do $$ begin
  if exists (select 1 from cron.job where jobname = 'secretshopper-reminders') then
    perform cron.unschedule('secretshopper-reminders');
  end if;
end $$;
select cron.schedule('secretshopper-reminders', '0 15 * * *', $job$
  select net.http_post(
    url     := 'https://rlqhgnavfuilivmmrmfu.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-reminder-secret', (select value from private.app_settings where key = 'reminder_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);
