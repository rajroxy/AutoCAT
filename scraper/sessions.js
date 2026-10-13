/**
 * Sessions: the cookies a page earned, kept so the next tier does not have to earn them
 * again.
 *
 * A media page answers a visitor in stages. It sets a cookie on the first request — a
 * consent choice, an age check, a token its player needs — and only then serves the URL
 * that matters. Every tier here is a *new* client as far as the site is concerned, so
 * without somewhere to keep those cookies tier 2 and tier 3 each start from nothing, and
 * a page that only serves a signed visitor serves none of them.
 *
 * The store is one JSON file on the server (`scraper/sessions.json`, git-ignored like the
 * other runtime state) keyed by domain, because a cookie belongs to a domain and not to
 * the URL that happened to receive it. It is written when it changes and read on demand,
 * and it holds nothing a browser's own cookie jar would not hold.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so checks never touch the real store.
const FILE = process.env.AUTOCAT_SESSIONS_FILE || path.join(__dirname, "sessions.json");

/** domain -> { cookies: [...], updated } */
let store = null;
let writing = null;

/** The host a URL points at, lower-cased. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The registrable-ish site a URL belongs to: `www.example.com` and `cdn.example.com` are one site. */
export function domainOf(url) {
  const host = hostOf(url);
  if (!host || host === "localhost" || /^[\d.]+$/.test(host)) return host;
  const parts = host.split(".");
  // `example.com` and `www.example.com` are the same site; `com` alone is not a domain.
  return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

/**
 * The store keys a URL's cookies may live under.
 *
 * **A cookie belongs where the site said it belongs.** A browser sends a host-only
 * cookie (no `Domain=` attribute) back to the exact host that set it, and a
 * `Domain=.example.com` cookie to the site and its subdomains — so the lookup walks from
 * the host up to its registrable parent and no further. Treating the whole site as one
 * bucket would hand `cdn.example.com`'s session to `www.example.com`, which no browser
 * would do and some sites would notice.
 */
function lookupKeys(url) {
  const host = hostOf(url);
  if (!host) return [];
  if (host === "localhost" || /^[\d.]+$/.test(host)) return [host];
  const keys = [host];
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) keys.push(parts.slice(i).join("."));
  return keys;
}

function load() {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    store = {};
  }
  return store;
}

function persist() {
  // Coalesced: a page can set a dozen cookies in a second, and one write is enough.
  if (writing) return;
  writing = setTimeout(() => {
    writing = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify(load(), null, 2) + "\n");
    } catch {
      /* read-only fs — the in-memory copy still applies for this run */
    }
  }, 250);
  writing.unref?.();
}

/** A `Set-Cookie` header string into one cookie object. */
function parseSetCookie(value, domain) {
  const [pair, ...attrs] = String(value).split(";");
  const eq = pair.indexOf("=");
  if (eq < 1) return null;
  const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain, path: "/", scoped: false };
  for (const attr of attrs) {
    const [k, v = ""] = attr.split("=");
    const key = k.trim().toLowerCase();
    if (key === "path" && v.trim()) cookie.path = v.trim();
    if (key === "domain" && v.trim()) {
      cookie.domain = v.trim().replace(/^\./, "");
      // An explicit domain is the site saying "this one goes to my subdomains too".
      cookie.scoped = true;
    }
    if (key === "max-age" && Number(v) <= 0) cookie.expired = true;
    if (key === "httponly") cookie.httpOnly = true;
    if (key === "secure") cookie.secure = true;
  }
  return cookie;
}

/** One cookie into the shape both a Cookie header and Playwright accept. */
function normalise(cookie, domain) {
  if (!cookie || typeof cookie !== "object" || !cookie.name) return null;
  const expires = Number(cookie.expires);
  return {
    name: String(cookie.name),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain || domain).replace(/^\./, ""),
    path: String(cookie.path || "/"),
    ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
  };
}

/**
 * Save (or refresh) a domain's cookies.
 *
 * Accepts what the sources of cookies actually produce: a `Set-Cookie` string, an array of
 * those, or cookie objects. Merging by name+path is deliberate — a site that re-issues its
 * session token must replace it, not end up with two.
 *
 * @param {string} domain
 * @param {string|string[]|object[]} cookies
 */
export function saveSession(domain, cookies) {
  const fallback = String(domain || "").replace(/^\./, "").toLowerCase();
  if (!fallback) return;
  const s = load();
  const parsed = (Array.isArray(cookies) ? cookies : [cookies])
    .map((c) => (typeof c === "string" ? parseSetCookie(c, fallback) : { ...c, scoped: Boolean(c?.domain) }))
    .filter(Boolean);

  let touched = false;
  for (const cookie of parsed) {
    if (!cookie?.name) continue;
    const key = (cookie.scoped && cookie.domain ? String(cookie.domain) : fallback).replace(/^\./, "").toLowerCase();
    const entry = s[key] || (s[key] = { cookies: [], updated: 0 });
    if (cookie.expired) {
      entry.cookies = entry.cookies.filter((c) => !(c.name === cookie.name && c.path === (cookie.path || "/")));
      touched = true;
      continue;
    }
    const kept = normalise(cookie, key);
    if (!kept) continue;
    const at = entry.cookies.findIndex((c) => c.name === cookie.name && c.path === (cookie.path || "/"));
    if (at >= 0) entry.cookies[at] = { ...entry.cookies[at], ...kept };
    else entry.cookies.push(kept);
    entry.updated = Date.now();
    touched = true;
  }
  if (touched) persist();
}

/**
 * The cookies saved for a URL's domain.
 *
 * @param {string} url
 * @returns {Array<object>} cookie objects (name, value, domain, path)
 */
export function getSession(url) {
  const keys = lookupKeys(url);
  if (!keys.length) return [];
  const s = load();
  const entries = keys.map((k) => s[k]).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const cookie of entry.cookies || []) {
      const id = `${cookie.name}|${cookie.path || "/"}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(cookie);
    }
  }
  return out;
}

/** The same cookies as a `Cookie:` request header, for the plain-HTTP tiers. */
export function cookieHeader(url) {
  return getSession(url)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * The same cookies in the shape Playwright's `addCookies` wants — one of them per
 * domain, because a browser context refuses a cookie whose domain it does not know.
 */
export function playwrightCookies(url) {
  const domain = domainOf(url);
  return getSession(url).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || domain,
    path: c.path || "/",
    ...(c.expires ? { expires: c.expires } : {}),
  }));
}

/**
 * Harvest the cookies a response set, so the next tier inherits the visitor's session.
 * Called by tier 1 on every page it reads — it is the only tier that sees raw headers.
 */
export function saveFromResponse(url, headers) {
  const host = hostOf(url);
  if (!host || !headers) return;
  let values = [];
  try {
    // Node's Headers has `getSetCookie()`; anything older only joins them into one string.
    values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    if (!values.length && headers.get) {
      const joined = headers.get("set-cookie");
      if (joined) values = [joined];
    }
  } catch {
    return;
  }
  // The host that answered, unless the cookie names a domain of its own.
  if (values.length) saveSession(host, values);
}

/** Forget one domain, or everything. Returns how many domains were dropped. */
export function clearSession(domain = "") {
  const s = load();
  const keys = domain ? lookupKeys(`http://${String(domain).replace(/^www\./, "")}/`) : Object.keys(s);
  let dropped = 0;
  for (const k of keys) {
    if (s[k]) {
      delete s[k];
      dropped += 1;
    }
  }
  if (dropped) persist();
  return dropped;
}

/** Every domain holding a session, for Settings and diagnostics. */
export function sessionDomains() {
  return Object.entries(load())
    .map(([domain, entry]) => ({
      domain,
      cookies: (entry.cookies || []).length,
      updated: entry.updated || 0,
    }))
    .sort((a, b) => b.updated - a.updated);
}
