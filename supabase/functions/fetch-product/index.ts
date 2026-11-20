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
  const pa = html.match(/"priceAmount":\s*([\d.]+)/) ||
             html.match(/id=["']corePrice[\s\S]{0,600}?class=["']a-offscreen["'][^>]*>\s*\$?([\d,]+\.\d{2})/i) ||
             html.match(/class=["']a-offscreen["'][^>]*>\s*\$([\d,]+\.\d{2})/i);
  if (pa) out.price = parsePrice(pa[1]);
  const bullets = [...html.matchAll(/<li[^>]*>\s*<span class=["']a-list-item["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => decode(m[1].replace(/<[^>]+>/g, ""))).filter((s) => s && s.length > 20);
  if (bullets.length) out.description = bullets[0];
  return out;
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

  let title = amz.title || ld.title || meta["og:title"] || meta["twitter:title"] || titleTag;
  title = cleanTitle(title, host, title === titleTag);

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
  return { title: blocked ? null : (title || null), image: blocked ? null : (image || null), price: blocked ? null : price,
           description: blocked ? null : description, site: host, blocked };
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

const json = (body) => new Response(JSON.stringify(body), { headers: { ...CORS, "Content-Type": "application/json" } });

async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { url } = await req.json();
    const u = new URL(String(url || "").trim());
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return json({ ok: false, error: "That doesn't look like a store link." });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(u.href, {
      redirect: "follow", signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timer);
    const finalUrl = res.url || u.href;
    if (isPrivateHost(new URL(finalUrl).hostname)) return json({ ok: false, error: "That doesn't look like a store link." });
    if (!/html|xml/i.test(res.headers.get("content-type") || "html")) return json({ ok: false, error: "That link isn't a web page." });

    const html = await readCapped(res);
    const data = extract(html, finalUrl);
    const ok = !!(data.title || data.image || data.price);
    return json({ ok, ...data, url: finalUrl, status: res.status,
      error: ok ? null : (data.blocked || res.status >= 400 ? "That store blocked the lookup." : "Couldn't find product details on that page.") });
  } catch (e) {
    return json({ ok: false, error: e?.name === "AbortError" ? "The store took too long to answer." : "Couldn't read that link." });
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) D.serve(handle);
