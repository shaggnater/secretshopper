// @ts-nocheck
// =====================================================================
// SecretShopper — send-reminders Edge Function
// Emails each person the gifts they've CLAIMED but not marked purchased,
// plus their Secret Santa gift once they've seen their match.
//
//  * Daily: called by the database scheduler with the x-reminder-secret
//    header. Sends to everyone whose reminders are on and who is due.
//  * Test: called from the app by a signed-in person with {test:true}.
//    Sends that person their reminder right now (max once per 2 minutes).
//
// Needs the RESEND_API_KEY secret. Deploy with "Verify JWT" OFF (it checks
// the scheduler secret or the person's sign-in itself).
// =====================================================================

const SITE = "https://secretshopper.online";
const env = (k) => globalThis.Deno?.env.get(k);
const FROM = env("REMINDER_FROM") || "SecretShopper <reminders@secretshopper.online>";
const SB_URL = env("SUPABASE_URL");
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");
const ANON = env("SUPABASE_ANON_KEY");
const RESEND = env("RESEND_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!r.ok) throw new Error(`${fn} failed: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---------- email rendering ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const money = (n) => (n == null ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const daysAgo = (t) => {
  const d = Math.floor((Date.now() - new Date(t).getTime()) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

function itemRow(it, extra) {
  const url = safeUrl(it.url), img = safeUrl(it.image);
  const title = url ? `<a href="${esc(url)}" style="color:#6d28d9;text-decoration:none;font-weight:600">${esc(it.title)}</a>`
                    : `<span style="font-weight:600;color:#1f1530">${esc(it.title)}</span>`;
  return `<tr>
    <td width="64" style="padding:10px 12px 10px 0;vertical-align:top">${img
      ? `<img src="${esc(img)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:contain;border-radius:8px;background:#fff;border:1px solid #eee">`
      : `<div style="width:56px;height:56px;border-radius:8px;background:#f3eefe;text-align:center;line-height:56px;font-size:26px">🎁</div>`}</td>
    <td style="padding:10px 0;vertical-align:top;font-size:15px;line-height:1.4">${title}
      <div style="color:#6b6380;font-size:13px;margin-top:3px">${[it.price != null ? money(it.price) + (it.qty > 1 ? ` × ${it.qty}` : "") : "", extra].filter(Boolean).join(" · ")}</div></td>
  </tr>`;
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#f97316;color:#1a0f05;font-weight:700;text-decoration:none;padding:11px 22px;border-radius:999px;font-size:15px">${label}</a>`;
}

export function render(u, isTest) {
  const claims = u.claims || [], santa = u.santa || [];
  const multiHouse = new Set(claims.map((c) => c.household)).size > 1;
  const groups = {};
  for (const c of claims) (groups[(multiHouse ? `${c.household}: ` : "") + c.for] ||= []).push(c);
  const total = claims.reduce((t, c) => t + (Number(c.price) || 0) * (c.qty || 1), 0);
  const n = claims.length + santa.length;

  const subject = (isTest ? "Test: " : "") + (n === 0 ? "Your SecretShopper reminders are set up"
    : n === 1 ? "🎁 You have 1 gift left to buy" : `🎁 You have ${n} gifts left to buy`);

  let body = "";
  if (claims.length) {
    body += `<p style="margin:0 0 6px;font-size:15px">You've claimed ${claims.length === 1 ? "this gift" : `these ${claims.length} gifts`} but haven't marked ${claims.length === 1 ? "it" : "them"} as bought yet:</p>`;
    for (const [who, items] of Object.entries(groups)) {
      body += `<h3 style="margin:18px 0 0;font-size:14px;color:#ea580c;text-transform:uppercase;letter-spacing:.04em">For ${esc(who)}</h3>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${items.map((it) => itemRow(it, `claimed ${daysAgo(it.claimed_at)}`)).join("")}</table>`;
    }
    if (total) body += `<p style="margin:14px 0 0;font-size:14px;color:#6b6380">About <b style="color:#1f1530">${money(total)}</b> left to spend.</p>`;
    body += `<p style="margin:20px 0 0">${button(`${SITE}/#cart`, "Open My Shopping")}</p>`;
  }
  for (const s of santa) {
    body += `<div style="margin-top:26px;padding:16px;border-radius:12px;background:#f6f1ff;border:1px solid #e3d6ff">
      <div style="font-size:13px;color:#6d28d9;font-weight:700">🎅 YOUR SECRET SANTA GIFT${s.limit != null ? ` · ${money(s.limit).replace(".00", "")} LIMIT` : ""}</div>
      <div style="font-size:17px;font-weight:700;margin:6px 0 4px;color:#1f1530">For ${esc(s.for)}</div>
      ${s.title ? `<table width="100%" cellpadding="0" cellspacing="0">${itemRow(s, "")}</table>`
                : `<div style="font-size:14px;color:#6b6380">The idea picked for you was removed; choose anything from their ideas within the limit.</div>`}
      <p style="margin:12px 0 0">${button(`${SITE}/#bonus`, "Open Bonus Gift")}</p>
      <div style="font-size:12px;color:#8a80a0;margin-top:8px">🤫 Only you get this. Don't forward it!</div></div>`;
  }
  if (!n) body = `<p style="font-size:15px">You're all caught up: nothing claimed and still waiting to be bought. When you claim a gift with <b>"I'm getting this"</b>, it'll show up in emails like this until you mark it purchased.</p>
    <p style="margin:18px 0 0">${button(SITE, "Open SecretShopper")}</p>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f2eff7;font-family:Arial,Helvetica,sans-serif;color:#1f1530">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f2eff7;padding:24px 12px"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
    <tr><td style="background:#1d1629;padding:18px 24px;font-size:22px;font-weight:800">
      <span style="color:#ffffff">🎁 Secret</span><span style="color:#f97316">Shopper</span></td></tr>
    <tr><td style="height:4px;background:linear-gradient(90deg,#7c3aed,#f97316);background-color:#7c3aed"></td></tr>
    <tr><td style="padding:24px">
      ${isTest ? `<div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:16px">This is a test email you sent from your reminder settings.</div>` : ""}
      <p style="margin:0 0 14px;font-size:18px;font-weight:700">Hi ${esc(u.name || "there")},</p>
      ${body}
    </td></tr>
    <tr><td style="padding:16px 24px;background:#faf8fd;color:#8a80a0;font-size:12px;line-height:1.5">
      Already bought something? Mark it <b>purchased</b> in the app and it drops off this list.<br>
      To change how often these come, or turn them off: <a href="${SITE}" style="color:#6d28d9">SecretShopper</a> → Account &amp; Household → Email reminders.
    </td></tr>
  </table></td></tr></table></body></html>`;

  const text = [`Hi ${u.name || "there"},`, "",
    ...(claims.length ? ["Gifts you've claimed but haven't marked bought:",
      ...claims.map((c) => `- ${c.title} for ${c.for}${c.price != null ? ` (${money(c.price)})` : ""}${c.url ? ` ${c.url}` : ""}`), "",
      `My Shopping: ${SITE}/#cart`, ""] : []),
    ...santa.map((s) => `Your Secret Santa gift for ${s.for}: ${s.title || "(pick from their ideas)"}${s.price != null ? ` (${money(s.price)})` : ""} ${SITE}/#bonus`),
    ...(n ? [] : ["You're all caught up. Nothing claimed and still waiting to be bought."]),
    "", "Change or stop these emails: Account & Household → Email reminders"].join("\n");
  return { subject, html, text };
}

async function send(to, msg) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject: msg.subject, html: msg.html, text: msg.text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!RESEND) return json({ ok: false, error: "Email isn't set up yet (missing RESEND_API_KEY)." }, 500);
  let body = {};
  try { body = await req.json(); } catch { /* empty */ }

  // ----- daily run from the scheduler -----
  const secret = req.headers.get("x-reminder-secret");
  if (secret) {
    if (!(await rpc("reminder_check_secret", { p: secret }))) return json({ ok: false, error: "forbidden" }, 403);
    const due = await rpc("reminder_batch", {});
    const sent = [], failed = [];
    for (const u of due) {
      try { await send(u.email, render(u, false)); sent.push(u.user_id); }
      catch (e) { failed.push(String(e.message || e)); }
      await new Promise((r) => setTimeout(r, 600));    // stay under the email service's rate limit
    }
    if (sent.length) await rpc("reminder_mark_sent", { p_users: sent, p_test: false });
    console.log(JSON.stringify({ mode: "daily", due: due.length, sent: sent.length, failed }));
    return json({ ok: true, sent: sent.length, failed: failed.length });
  }

  // ----- "send me a test" from the app -----
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const who = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON || SERVICE, Authorization: `Bearer ${token}` } });
  if (!who.ok) return json({ ok: false, error: "Please sign in again." }, 401);
  const user = await who.json();
  if (!body.test) return json({ ok: false, error: "Nothing to do." }, 400);

  const prefs = await fetch(`${SB_URL}/rest/v1/reminder_prefs?user_id=eq.${user.id}&select=last_test_at`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then((r) => r.json());
  if (!prefs.length) return json({ ok: false, error: "Save your reminder settings first." }, 400);
  if (prefs[0].last_test_at && Date.now() - new Date(prefs[0].last_test_at).getTime() < 120000)
    return json({ ok: false, error: "You just sent one. Try again in a couple of minutes." }, 429);

  const [u] = await rpc("reminder_batch", { p_user: user.id, p_force: true });
  if (!u) return json({ ok: false, error: "Couldn't find your account email." }, 400);
  try { await send(u.email, render(u, true)); }
  catch (e) {
    console.log(JSON.stringify({ mode: "test", error: String(e.message || e) }));
    return json({ ok: false, error: /domain|verify/i.test(String(e)) ? "The email domain isn't verified yet." : "The email service refused the message." }, 502);
  }
  await rpc("reminder_mark_sent", { p_users: [user.id], p_test: true });
  console.log(JSON.stringify({ mode: "test", sent: 1, items: u.claims.length, santa: u.santa.length }));
  return json({ ok: true, email: u.email, items: u.claims.length + u.santa.length });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) D.serve(handle);
