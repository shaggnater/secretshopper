# SecretShopper

A family wish-list app. Everyone sees what's been claimed or bought from each other's lists, except the person whose list it is.

Live site: https://shaggnater.github.io/secretshopper/

| File | What it is |
|---|---|
| `index.html` | The whole website, hosted by GitHub Pages |
| `schema.sql` | Database tables and the secrecy rules. Run it once in Supabase. |
| `supabase/functions/fetch-product/index.ts` | Reads a store link and fills in the name, photo, price and description |

## Setup

### 1. Supabase database
1. Create a project at supabase.com.
2. Open **SQL Editor → New query**, paste in all of `schema.sql`, and click **Run**.

### 2. Connect the site
Find your **Project URL** and **anon / publishable key** in Supabase under **Project Settings → API**. Put them near the top of the `<script>` in `index.html`:
```js
const SUPABASE_URL      = "https://xxxxxxxx.supabase.co";   // nothing after .co
const SUPABASE_ANON_KEY = "sb_publishable_...";
```
Never use the `service_role` or secret key.

### 3. GitHub Pages
Go to repo **Settings → Pages**. Under Source, choose **Deploy from a branch**, then **main** and **/ (root)**.

### 4. Supabase sign-in settings
- **Authentication → URL Configuration:**
  - **Site URL:** `https://shaggnater.github.io/secretshopper/`
  - **Redirect URLs:** add `https://shaggnater.github.io/secretshopper/**`
- **Authentication → Sign In / Providers → Email:** turn off **Confirm email**. Supabase's built-in email sender only sends 2 emails an hour and only to your own Supabase team, so family sign-ups would hit "email rate limit exceeded".

### 5. Use it
Create your account, create a household, and click **+ Invite family** to text everyone the link.

### 6. Product lookup (fills in items from a link)
This runs on Supabase, because browsers can't read other stores' pages directly.

1. In Supabase, open **Edge Functions** and click **Deploy a new function**, then **Via Editor**.
2. Name it exactly `fetch-product`.
3. Delete the sample code, paste in all of `supabase/functions/fetch-product/index.ts`, and click **Deploy function**.
4. Leave **Verify JWT** on (the default), so only signed-in family members can use it.

Now when you paste a link in **+ Add an item**, the name, photo, price and a short description fill in automatically. Every field stays editable. If a store blocks the lookup (Amazon sometimes does), or a detail can't be found, the app says so and you type that part in. The lookup never overwrites anything you've already typed, unless you click **Get details** yourself.

## How the secret is kept
Supabase Row Level Security does the hiding inside the database. The `item_status` and `comments` tables return nothing to the owner of an item, even if someone pokes at the API directly. Your own list shows "Status hidden from you" because the server never sends your list's status at all.

Lists and members update live. Claim and purchase statuses refresh every 15 seconds and whenever you return to the tab. They're kept out of live updates on purpose, because Supabase's live delete events could otherwise hint to an owner that something of theirs had been claimed.

## Good to know
- If an owner deletes an item someone already bought, the buyer's claim disappears with it. Keep items on your list until after the holidays.
- A person can belong to more than one household. Switch between them with the **Household** menu.
- Admins can rename the household, remove members, and make a new invite code, which stops the old link from working.
