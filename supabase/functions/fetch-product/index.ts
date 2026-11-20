// @ts-nocheck
// =====================================================================
// SecretShopper — fetch-product Edge Function
// Reads a store's product page and returns { title, image, price, description }.
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function →
//         Via Editor → name it  fetch-product  → paste this file → Deploy.
// Leave "Verify JWT" ON so only signed-in family members can use it.
// =====================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BYTES = 2_500_000;

// ---------- helpers ----------
export function decode(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function attrs(tag) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  return out;
}

function metaMap(html) {
  const map = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    if (key && a.content != null && !(key in map)) map[key] = decode(a.content);
  }
  return map;
}

export function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  const s = String(v).replace(/\s/g, "");
  const m = s.match(/\d[\d,]*(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  return isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
}

function firstImage(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return firstImage(img[0]);
  if (typeof img === "object") return img.url || img.contentUrl || null;
  return null;
}

function findProduct(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const p = findProduct(n, depth + 1); if (p) return p; }
    return null;
  }
  if (typeof node !== "object") return null;
  const t = node["@type"];
  const types = Array.isArray(t) ? t : [t];
  if (types.some((x) => /^(Product|ProductGroup|IndividualProduct)$/i.test(String(x)))) return node;
  for (const k of ["@graph", "mainEntity", "itemListElement", "hasVariant"]) {
    const p = findProduct(node[k], depth + 1); if (p) return p;
  }
  return null;
}

function offerPrice(offers) {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    const p = parsePrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price ??
      (Array.isArray(o.priceSpecification) ? o.priceSpecification[0]?.price : null));
    if (p) return p;
    if (o.offers) { const q = offerPrice(o.offers); if (q) return q; }
  }
  return null;
}

function jsonLdProduct(html) {
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const p = findProduct(JSON.parse(m[1].trim()));
      if (p) {
        return {
          title: decode(p.name),
          image: firstImage(p.image),
          price: offerPrice(p.offers) ?? offerPrice(p.hasVariant?.[0]?.offers),
          description: decode(p.description),
        };
      }
    } catch { /* bad JSON on page, skip */ }
  }
  return {};
}

function amazon(html) {
  const out = {};
  const t = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  if (t) out.title = decode(t[1]);
  const hi = html.match(/data-old-hires=["'](https:[^"']+)["']/i) ||
             html.match(/"hiRes":"(https:[^"]+)"/) ||
             html.match(/id=["']landingImage["'][^>]*src=["'](https:[^"']+)["']/i) ||
             html.match(/"large":"(https:[^"]+)"/);
  if (hi) out.image = hi[1];
  const pr = amazonPrice(html);
  out.price = pr.price; out.priceSource = pr.source;
  const bullets = [...html.matchAll(/<li[^>]*>\s*<span class=["']a-list-item["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => decode(m[1].replace(/<[^>]+>/g, ""))).filter((s) => s && s.length > 20);
  if (bullets.length) out.description = bullets[0];
  return out;
}

// Amazon price: the price you'd actually pay, preferring a Prime-member / deal price
// over the regular price. (The lookup sees Amazon logged out, so a Prime-exclusive
// deal shows up only as a "Prime members pay $X" message, not as the main price.)
export function amazonPrice(html) {
  const MONEY = /\$\s?([\d,]+\.\d{2})/;
  const markers = ["corePriceDisplay_desktop_feature_div", "corePrice_desktop", "corePrice_feature_div",
                   "apex_desktop", "corePriceDisplay_mobile_feature_div", "corePrice_mobile_feature_div", "apex_offerDisplay_mobile", "apex_mobile"];
  let start = -1;
  for (const m of markers) { const i = html.indexOf(`id="${m}"`); if (i >= 0 && (start < 0 || i < start)) start = i; }
  const region = start >= 0 ? html.slice(start, start + 20000) : html;   // unknown layout: scan the page

  // the main "price to pay" in the buy box
  let p2p = null;
  const p2pm = region.match(/class=["'][^"']*(?:priceToPay|apexPriceToPay)[^"']*["'][\s\S]{0,300}?class=["']a-offscreen["'][^>]*>\s*([^<]+)</i);
  if (p2pm) p2p = parsePrice(p2pm[1].match(MONEY)?.[1] ?? p2pm[1]);

  // first ordinary price in the buy box that isn't crossed out, a saving, or a monthly payment
  let firstPlain = null;
  for (const m of region.matchAll(/class=["']a-offscreen["'][^>]*>\s*([^<]+)</gi)) {
    const before = region.slice(Math.max(0, m.index - 400), m.index);
    const open = before.lastIndexOf('<span class="a-price');
    const wrapper = open >= 0 ? before.slice(open, before.indexOf(">", open) + 1) : "";
    if (/data-a-strike|a-text-price/i.test(wrapper)) continue;                       // crossed-out list price
    const lead = before.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(-60);
    if (/you save|savings|list price|typical price|was:?\s*$/i.test(lead)) continue;
    const after = region.slice(m.index, m.index + 200).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 40);
    if (/\/\s?mo\b|per month|monthly/i.test(after)) continue;
    const v = parsePrice(m[1].match(MONEY)?.[1]); if (v) { firstPlain = v; break; }
  }

  // Prime-member / Prime-exclusive price messages anywhere on the page
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
                   .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
  const primeRe = /(prime\s+(?:exclusive\s+|member\s+)*(?:price|deal|discount)|prime\s+members?\b|join\s+prime\s+to\s+(?:buy|get|save)|with\s+(?:a\s+)?prime\b|exclusive\s+prime\s+price)[^$]{0,140}\$\s?([\d,]+\.\d{2})|\$\s?([\d,]+\.\d{2})\s*(?:with\s+prime|for\s+prime\s+members|exclusive\s+prime\s+price)/gi;
  const primes = [];
  for (const m of text.matchAll(primeRe)) {
    const ctx = text.slice(Math.max(0, m.index - 30), m.index + m[0].length) + text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/\/\s?mo\b|per month|shipping|delivery|orders over|free trial|membership|\/year|annual/i.test(ctx)) continue;
    const v = parsePrice(m[2] ?? m[3]); if (v) primes.push(v);
  }

  const json = parsePrice(html.match(/"priceAmount":\s*([\d.]+)/)?.[1]);
  const base = p2p ?? firstPlain ?? json ?? null;
  const primeBest = primes.filter((v) => !base || (v < base && v >= base * 0.3)).sort((a, b) => a - b)[0];
  if (primeBest) return { price: primeBest, source: "prime" };
  if (base) return { price: base, source: p2p ? "priceToPay" : firstPlain ? "buybox" : "json" };
  return { price: null, source: null };
}

function cleanTitle(t, site, isTitleTag) {
  if (!t) return t;
  t = t.replace(/^Amazon\.com\s*:\s*/i, "").replace(/\s*:\s*Amazon\.com.*$/i, "")
       .replace(/\s*:\s*[\w\s&,]+$/i, (m) => (m.length < 40 && /amazon/i.test(site) ? "" : m));
  if (!isTitleTag) return t.trim();
  // <title> fallback only: drop "… - Target" / "… | Walmart.com"
  const parts = t.split(/\s+[|\-–—]\s+/);
  if (parts.length > 1 && parts[parts.length - 1].length <= 30) parts.pop();
  return parts.join(" - ").trim();
}

export function extract(html, pageUrl) {
  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  const meta = metaMap(html);
  const ld = jsonLdProduct(html);
  const amz = /amazon\./i.test(host) ? amazon(html) : {};
  const titleTag = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);

  const h1 = decode(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " "));
  const metaName = meta["og:title"] || meta["twitter:title"] || meta["name"] || meta["title"];
  let title = amz.title || ld.title || metaName;
  if (!title && h1 && h1.length >= 4 && h1.length <= 200) title = h1;
  let fromTag = false;
  if (!title && titleTag) { title = titleTag; fromTag = true; }
  title = cleanTitle(title, host, fromTag);
  if (title && /^(amazon(\.com)?|robot check|access denied|page not found|404.*|sorry.*|just a moment.*)$/i.test(title)) title = null;

  let image = amz.image || ld.image || meta["og:image"] || meta["og:image:secure_url"] ||
              meta["twitter:image"] || meta["twitter:image:src"] || meta["image"];
  if (image) { try { image = new URL(image, pageUrl).href; } catch { image = null; } }
  if (image && !/^https?:\/\//i.test(image)) image = null;

  const price = amz.price ?? ld.price ??
    parsePrice(meta["product:price:amount"] ?? meta["og:price:amount"] ?? meta["price"] ?? meta["twitter:data1"]) ??
    parsePrice(html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1]) ?? null;

  let description = amz.description || ld.description || meta["og:description"] || meta["description"] || meta["twitter:description"] || null;
  if (description) description = description.length > 220 ? description.slice(0, 217).replace(/\s+\S*$/, "") + "…" : description;

  const blocked = /robot check|captcha|access denied|are you a human|pardon our interruption|request blocked/i.test(titleTag || "") && !ld.title && !amz.title;
  if (blocked) title = null;
  return { title: title || null, image: blocked ? null : (image || null), price: blocked ? null : price,
           description: blocked ? null : description, site: host, blocked,
           priceSource: amz.price != null ? amz.priceSource : (ld.price != null ? "jsonld" : (price != null ? "meta" : null)) };
}

// "amazon.com/Lodge-Cast-Iron-Skillet-12/dp/B00…" → "Lodge Cast Iron Skillet 12"
export function titleFromUrl(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const skip = /^(dp|gp|p|ip|product|products|site|item|items|shop|buy|en|us|en-us|s|pd|prd|detail|details|catalog)$/i;
    const segs = u.pathname.split("/").map((x) => decodeURIComponent(x))
      .filter((x) => x && !skip.test(x) && /[a-z]{3}/i.test(x) && /[-_+ ]/.test(x) && !/^[A-Z0-9]{8,}$/.test(x));
    if (!segs.length) return null;
    let best = segs.sort((a, b) => b.length - a.length)[0]
      .replace(/\.(html?|aspx?|php)$/i, "").replace(/[-_+]+/g, " ")
      .replace(/\b(A|N|P)-?\d{6,}\b/gi, "").replace(/\b\d{6,}\b/g, "").replace(/\s+/g, " ").trim()
      .replace(/(\w) s\b/g, "$1's");
    if (best.length < 4) return null;
    return best.replace(/(^|\s)([a-z])/g, (_, sp, c) => sp + c.toUpperCase());
  } catch { return null; }
}

function isPrivateHost(h) {
  h = h.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h === "metadata.google.internal") return true;
  return false;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks = []; let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  try { reader.cancel(); } catch { /* ignore */ }
  const buf = new Uint8Array(total); let off = 0;
  for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, total - off)), off); off += c.length; if (off >= total) break; }
  return new TextDecoder("utf-8").decode(buf);
}

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

async function fetchPage(href, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(href, {
      redirect: "follow", signal: ctrl.signal,
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await readCapped(res);
    return { res, html };
  } finally { clearTimeout(timer); }
}

const json = (body) => new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });

async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let rawUrl = "";
  try { rawUrl = String((await req.json())?.url || "").trim(); } catch { /* no body */ }
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return json({ ok: false, error: "That doesn't look like a store link." });

    let { res, html } = await fetchPage(u.href, DESKTOP_UA);
    let finalUrl = res.url || u.href;
    if (isPrivateHost(new URL(finalUrl).hostname)) return json({ ok: false, error: "That doesn't look like a store link." });
    if (!/html|xml/i.test(res.headers.get("content-type") || "html")) return json({ ok: false, error: "That link isn't a web page." });

    let data = extract(html, finalUrl);
    if (data.blocked || res.status >= 500 || res.status === 403 || !(data.title || data.image || data.price)) {
      try {   // one retry as a phone browser — some stores block one but not the other
        const second = await fetchPage(finalUrl, MOBILE_UA);
        const d2 = extract(second.html, second.res.url || finalUrl);
        const score = (d) => (d.title ? 1 : 0) + (d.image ? 1 : 0) + (d.price != null ? 1 : 0);
        if (score(d2) > score(data)) { data = d2; res = second.res; finalUrl = second.res.url || finalUrl; }
      } catch { /* keep first result */ }
    }
    if (!data.title) data.title = titleFromUrl(finalUrl) || titleFromUrl(u.href);
    const ok = !!(data.title || data.image || data.price);
    console.log(JSON.stringify({ host: data.site, status: res.status, blocked: data.blocked,
      found: { name: !!data.title, photo: !!data.image, price: data.price != null, description: !!data.description },
      priceSource: data.priceSource ?? null }));
    return json({ ok, ...data, url: finalUrl, status: res.status,
      error: ok ? null : (data.blocked || res.status >= 400 ? "That store blocked the lookup." : "Couldn't find product details on that page.") });
  } catch (e) {
    let title = null;
    title = titleFromUrl(rawUrl);
    console.log(JSON.stringify({ error: String(e?.message || e), nameFromLink: !!title }));
    if (title) return json({ ok: true, title, image: null, price: null, description: null,
      note: e?.name === "AbortError" ? "The store took too long to answer." : "Couldn't read that page." });
    return json({ ok: false, error: e?.name === "AbortError" ? "The store took too long to answer." : "Couldn't read that link." });
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) D.serve(handle);
