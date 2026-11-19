# SecretShopper — setup (about 10 minutes)

Two files make up the app:
- `schema.sql` creates the database and the secrecy rules.
- `index.html` is the whole website.

## 1. Supabase
1. Go to supabase.com and create a **New project**. Call it `secretshopper` and save the database password somewhere safe.
2. Open **SQL Editor**, click **New query**, paste in all of `schema.sql`, and click **Run**. It should say "Success. No rows returned."
3. Open **Project Settings → API** and copy two things:
   - **Project URL**
   - **anon public** key (the long one; never the `service_role` key)

## 2. Connect the site
Open `index.html` in a text editor. Near the top of the `<script>`, replace:
```js
const SUPABASE_URL      = "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
```
with your two values. The anon key is meant to be public. The database rules protect the data.

## 3. Deploy to Netlify
- **Quickest:** drag the `secretshopper` folder onto https://app.netlify.com/drop
- **Or:** put it in a GitHub repo and connect that repo in Netlify, like you did for YayNay. It needs no build step and the publish directory is the repo root.
- Rename the site to something like `secretshopper-family.netlify.app` (Site configuration → Change site name).

## 4. Point Supabase sign-up emails at your site
In Supabase, open **Authentication → URL Configuration**:
- **Site URL:** `https://your-site.netlify.app`
- **Redirect URLs:** add `https://your-site.netlify.app/**`

If you skip this, the "confirm your email" links go to localhost.

*Optional:* to let family sign up without confirming their email, open **Authentication → Sign In / Providers → Email** and turn off **Confirm email**. Supabase's built-in email sender is also limited to a few emails per hour, which is fine for a family.

## 5. Use it
1. Create your account, then **Create a household** (for example "The Millers"). You become its admin.
2. Click **+ Invite family** and text everyone the link. When they open it, they make an account and land in your household.
3. Each person adds items to **Your List**: title, link, price, quantity, notes, a ★ must-have flag, and an optional picture link (right-click a product photo, then "Copy image address").
4. On anyone else's list you can:
   - **I'm getting this** to claim an item so nobody doubles up,
   - **Mark purchased**,
   - **Release** an item if you change your mind,
   - post **Secret notes** ("want to go halves?").
5. **My Shopping** (the cart icon) shows everything you've claimed or bought, grouped by person, with what you've spent and what's left to spend.

## How the secret is kept
Supabase Row Level Security does the hiding inside the database. The `item_status` and `comments` tables return nothing to the owner of an item, even if someone pokes at the API directly. Your own list shows "Status hidden from you" because the server never sends your list's status at all.

Lists and members update live. Claim and purchase statuses refresh every 15 seconds and whenever you return to the tab. They're kept out of live updates on purpose, because Supabase's live delete events could otherwise hint to an owner that something of theirs had been claimed.

## Good to know
- If an owner deletes an item someone already bought, the buyer's claim disappears with it. Tell family to keep items on their list until the holidays are over.
- A person can belong to more than one household (for example their own family plus the in-laws). Switch between them with the **Household** dropdown.
- Admins can rename the household, remove members, and make a new invite code, which stops the old link from working.
