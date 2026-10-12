/**
 * **Sign in — Google and GitHub, straight OAuth 2.0.**
 *
 * The app offers exactly two ways in, and neither of them is a password: the account lives
 * with Google or GitHub, and this module is only the half of the handshake a server can do
 * — send the browser to the provider, take the code back, exchange it for a token, read the
 * profile off that token, and remember who it is behind an HttpOnly cookie.
 *
 * ## What it needs
 *
 * A client id and secret from each provider — **pasted in Settings → Sign in, or set on
 * the machine's environment** — and a public URL to come back to:
 *
 *   Settings → Sign in → Google / GitHub    (client id + client secret; the id is shown
 *                                            back, the secret is only ever reported as set)
 *   NUVIO_GOOGLE_CLIENT_ID / NUVIO_GOOGLE_CLIENT_SECRET
 *   NUVIO_GITHUB_CLIENT_ID / NUVIO_GITHUB_CLIENT_SECRET
 *   NUVIO_PUBLIC_URL            (e.g. https://tv.example.com — the preview origin works too)
 *
 * Settings comes first and the environment second (`signinKeys` in `addon/settings.mjs`
 * settles that), so both a folder install with a form and a server with env vars work.
 *
 * The callback to register with each provider is `<NUVIO_PUBLIC_URL>/auth/<provider>/callback`,
 * and `redirectUri` below is the one function that says so — **the same string is shown in
 * Settings**, because a callback that is registered with a different host, port or trailing
 * slash is the failure this handshake cannot recover from. Without keys, signing in is *off*
 * and the profile pane says so — it never pretends to have a login it cannot finish. The
 * endpoint URLs themselves can be overridden (`NUVIO_GOOGLE_AUTHORIZE_URL`, … `_TOKEN_URL`,
 * `_USERINFO_URL`) which is also how the test suite points them at a local stand-in for the
 * provider.
 *
 * ## What it is not
 *
 * - No password is ever stored, and no provider token is kept: only the profile it named.
 * - Sessions live in memory, so a server restart signs everyone out. That is the honest
 *   default for an app whose data still lives on this machine; the day the data moves to an
 *   account, the session store moves with it.
 * - Nothing here is used to *authorise* an API call to Google or GitHub. The token is spent
 *   on one request (who is this?) and dropped.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { signinKeys } from "./settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const env = (name, fallback = "") => process.env[name] || fallback;
/** `https://host/` → `https://host` (the callback path is appended to this). */
const trimSlash = (url) => String(url || "").replace(/\/+$/, "");

const PROVIDERS = {
  google: {
    label: "Google",
    // **Settings first, the environment second** (see `signinKeys`): the id and the
    // secret are one pair from one place, so a provider is never half-configured by a
    // pasted id meeting an environment secret.
    id: () => signinKeys("google").id,
    secret: () => signinKeys("google").secret,
    enabled: () => signinKeys("google").enabled,
    authorize: () => env("NUVIO_GOOGLE_AUTHORIZE_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
    token: () => env("NUVIO_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
    userinfo: () => env("NUVIO_GOOGLE_USERINFO_URL", "https://openidconnect.googleapis.com/v1/userinfo"),
    scope: "openid email profile",
    // The OpenID userinfo answer is already the shape we want.
    read: (info) => ({ id: String(info.sub || ""), name: info.name || info.email || "", email: info.email || "", picture: info.picture || "" }),
  },
  github: {
    label: "GitHub",
    id: () => signinKeys("github").id,
    secret: () => signinKeys("github").secret,
    enabled: () => signinKeys("github").enabled,
    authorize: () => env("NUVIO_GITHUB_AUTHORIZE_URL", "https://github.com/login/oauth/authorize"),
    token: () => env("NUVIO_GITHUB_TOKEN_URL", "https://github.com/login/oauth/access_token"),
    userinfo: () => env("NUVIO_GITHUB_USERINFO_URL", "https://api.github.com/user"),
    emails: () => env("NUVIO_GITHUB_EMAILS_URL", "https://api.github.com/user/emails"),
    scope: "read:user user:email",
    read: (info) => ({ id: String(info.id || ""), name: info.name || info.login || "", email: info.email || "", picture: info.avatar_url || "" }),
  },
};

/** The providers this build offers, and whether each one can actually finish a sign-in. */
export const authProviders = () =>
  Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    label: p.label,
    // A row switched off in Settings is not a way in, however complete its pair is.
    configured: Boolean(p.enabled?.() !== false && p.id() && p.secret()),
  }));

/** Is anything to sign in with set up at all? */
export const authConfigured = () => authProviders().some((p) => p.configured);

/**
 * In-flight sign-ins, by `state`.
 *
 * `state` is the anti-forgery half of the handshake: the value this server made is the
 * value that must come back, so a code from somewhere else cannot be replayed into a
 * session here. Each one is single-use and expires.
 */
const pending = new Map();
const STATE_MS = 10 * 60 * 1000;

/** Who is signed in, by session id. `expires` is a wall-clock time in ms. */
const sessions = new Map();
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------- this machine's own account */

/**
 * **A way in that always works, because it is this machine's own.**
 *
 * Google and GitHub are the two ways in *when they are set up* — and two client ids and
 * two secrets are exactly what a fresh install does not have. A card whose only control
 * is a sentence about environment variables is not a sign-in; it is a dead end, and it is
 * what this app showed. So there is one account of its own: a name and an optional
 * address, kept on this machine in `addon/account.json` (runtime state, git-ignored;
 * `NUVIO_ACCOUNT_FILE` moves it, which is how the tests stay out of the real one).
 *
 * It is **not** a second account system beside the providers. It is the same session, the
 * same cookie and the same `/auth/me`; the only thing it does differently is survive a
 * restart, because a session id that lives only in memory is gone the moment the server
 * reloads — and a sign-in that forgets you is not worth pressing. The file keeps the id
 * it has already accepted, so the cookie is still good next launch.
 */
const ACCOUNT_FILE = process.env.NUVIO_ACCOUNT_FILE || path.join(__dirname, "account.json");

/** `undefined` = not read yet, `null` = nobody has signed in on this machine. */
let accountCache;

function readAccount() {
  if (accountCache !== undefined) return accountCache;
  try {
    const held = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
    accountCache = held && held.id && held.name ? held : null;
  } catch {
    // No file, or nothing readable in it: nobody has signed in here yet.
    accountCache = null;
  }
  return accountCache;
}

const writeAccount = (account) => {
  accountCache = account;
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE, `${JSON.stringify(account, null, 2)}\n`);
  } catch {
    // A machine that cannot write it still signs in for this run; the file is a
    // convenience, not the session itself.
  }
};

/** The account this machine remembers, if one was made. No session needed to *read* it. */
export const localAccount = () => {
  const held = readAccount();
  return held ? { id: held.id, name: held.name, email: held.email || "", picture: held.picture || "", provider: "local" } : null;
};

const clean = () => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
};

/** The cookie the browser carries. HttpOnly, SameSite=Lax (the callback is a top-level GET). */
export const SESSION_COOKIE = "nuvio_session";

const cookieId = (req) => {
  const raw = String(req.headers.cookie || "");
  const hit = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return hit ? hit.slice(SESSION_COOKIE.length + 1) : "";
};

export function readSession(req) {
  clean();
  const id = cookieId(req);
  if (!id) return null;
  const found = sessions.get(id);
  if (found) return { ...found.user, expires: found.expires };
  // **A restart is not a sign-out for this machine's own account.** A provider's session
  // is a token this server was handed; this one is the machine's own, so the id it has
  // already accepted is written down and the cookie stands until the account is forgotten.
  const held = readAccount();
  if (held && held.sessionId === id) {
    const user = { id: held.id, name: held.name, email: held.email || "", picture: held.picture || "", provider: "local" };
    const record = { user, expires: Date.now() + SESSION_MS };
    sessions.set(id, record);
    return { ...user, expires: record.expires };
  }
  return null;
}

/** An address is optional here, so an empty one is fine — a wrong-looking one is not. */
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * Sign in on this machine, making the account the first time.
 *
 * No name means "come back as the one you already are" — that is the Continue button
 * after a sign-out, one press, with nothing typed. A name that is only whitespace is not
 * a name and is refused rather than stored, and so is an address that is not one: this is
 * the whole of the validation, because there is no password and nothing to verify against.
 */
export function signInLocal({ name, email } = {}) {
  const held = readAccount();
  const typed = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!typed && !held) throw new Error("A name is needed — that is the whole account.");
  const wanted = typed || held.name;
  const address = String(email ?? held?.email ?? "").trim().slice(0, 120);
  if (address && !looksLikeEmail(address)) throw new Error("That address does not look like one.");
  const user = { id: held?.id || `local-${randomBytes(6).toString("hex")}`, name: wanted, email: address, picture: held?.picture || "", provider: "local" };
  // **The same session id every time.** Signing out clears the cookie, not the account,
  // so coming back reuses the id the file already vouches for.
  const sessionId = held?.sessionId || randomBytes(24).toString("base64url");
  writeAccount({ ...user, sessionId, since: held?.since || new Date().toISOString() });
  sessions.set(sessionId, { user, expires: Date.now() + SESSION_MS });
  return { user, sessionId };
}

/** Forget this machine's account, and the session that goes with it. */
export function forgetLocal() {
  const held = readAccount();
  if (held?.sessionId) sessions.delete(held.sessionId);
  accountCache = null;
  try {
    fs.rmSync(ACCOUNT_FILE, { force: true });
  } catch {
    // Nothing to remove, or nowhere to remove it from.
  }
  return true;
}

export const signOut = (req) => {
  const raw = String(req.headers.cookie || "");
  const hit = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (hit) sessions.delete(hit.slice(SESSION_COOKIE.length + 1));
};

/**
 * **The callback to register with the provider — one function, so the string cannot
 * drift.** `origin` is where the request came in; `NUVIO_PUBLIC_URL` wins when it is set,
 * which is what a server behind a proxy wants. The desktop app pins its port and sets
 * `NUVIO_PUBLIC_URL` to match (see `desktop/main.js`), because a callback registered
 * against a port the app picks at random each launch is a callback that stops working on
 * the next launch.
 */
export const redirectUri = (providerKey, origin) =>
  `${trimSlash(env("NUVIO_PUBLIC_URL") || origin)}/auth/${providerKey}/callback`;

/** Whether a provider can finish a sign-in right now (the same test the UI is given). */
const usable = (p) => Boolean(p && p.enabled?.() !== false && p.id() && p.secret());

/**
 * Where to send the browser to sign in.
 *
 * `origin` is where this request came in — the preview origin, a LAN address, the desktop
 * app's own localhost. It is only used when `NUVIO_PUBLIC_URL` is not set, and it is
 * **built from the request**, never from a query parameter: a redirect target a stranger
 * can choose is an open redirect.
 */
export function startUrl(providerKey, origin, next = "") {
  const p = PROVIDERS[providerKey];
  if (!usable(p)) return null;
  clean();
  const state = randomBytes(18).toString("base64url");
  pending.set(state, { provider: providerKey, expires: Date.now() + STATE_MS, next });
  const back = redirectUri(providerKey, origin);
  const url = new URL(p.authorize());
  url.searchParams.set("client_id", p.id());
  url.searchParams.set("redirect_uri", back);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", state);
  // Google needs both to hand back a refresh-less offline-free code; harmless on others.
  if (providerKey === "google") {
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
  }
  return { url: url.toString(), state, redirectUri: back };
}

/**
 * Finish the handshake: code in, session out.
 *
 * Returns the signed-in user, or throws with something worth showing on the page. The
 * `state` is checked *before* the code is spent, and single-use either way.
 */
export async function finish(providerKey, { code = "", state = "", origin = "" } = {}) {
  const p = PROVIDERS[providerKey];
  if (!p) throw new Error("That sign-in is not one this app offers.");
  if (!usable(p)) throw new Error(`${p.label} sign-in is not set up — add its client id and secret in Settings → Sign in.`);
  clean();
  // **The state is the anti-forgery half.** Only a value this server minted, for this
  // provider, and not yet spent, can finish a sign-in — a code delivered to someone else's
  // browser cannot become a session here.
  const held = pending.get(String(state || ""));
  if (!held || held.provider !== providerKey) throw new Error("This sign-in link has expired — start again.");
  pending.delete(state);
  if (!code) throw new Error("The provider did not return a code.");

  const back = redirectUri(providerKey, origin);
  const body = new URLSearchParams({
    client_id: p.id(),
    client_secret: p.secret(),
    code,
    grant_type: "authorization_code",
    redirect_uri: back,
  });
  const tokenRes = await fetch(p.token(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const tokenText = await tokenRes.text();
  let token = {};
  try {
    token = JSON.parse(tokenText);
  } catch {
    // GitHub answers form-encoded unless asked for JSON; `accept` above asks, but a proxy
    // can still hand back the old shape.
    token = Object.fromEntries(new URLSearchParams(tokenText));
  }
  if (!tokenRes.ok || !token.access_token) {
    throw new Error(token.error_description || token.error || `The provider refused the sign-in (HTTP ${tokenRes.status}).`);
  }

  const headers = { authorization: `Bearer ${token.access_token}`, accept: "application/json", "user-agent": "Nuvio" };
  const info = await (await fetch(p.userinfo(), { headers })).json();
  let user = p.read(info);
  // **GitHub keeps the address private.** `/user` answers `email: null` for anyone whose
  // address is not public, and the address is worth having — it is what names the account.
  if (providerKey === "github" && !user.email) {
    const list = await (await fetch(p.emails(), { headers })).json().catch(() => []);
    const primary = Array.isArray(list) ? list.find((e) => e.primary) || list[0] : null;
    if (primary?.email) user = { ...user, email: primary.email };
  }
  if (!user.id) throw new Error(`The provider did not say who this is.`);

  const sessionId = randomBytes(24).toString("base64url");
  const record = { user: { ...user, provider: providerKey }, expires: Date.now() + SESSION_MS };
  sessions.set(sessionId, record);
  return { user: record.user, sessionId, next: held.next };
}

/** The `Set-Cookie` for a finished sign-in. */
export const sessionCookie = (id, secure) =>
  `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure ? "; Secure" : ""}`;

/** The `Set-Cookie` that ends one. */
export const clearCookie = (secure) =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

/** For tests and for a server that wants to know it is empty. */
export const sessionCount = () => sessions.size;
