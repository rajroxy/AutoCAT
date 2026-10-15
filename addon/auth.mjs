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
 *   AUTOCAT_GOOGLE_CLIENT_ID / AUTOCAT_GOOGLE_CLIENT_SECRET
 *   AUTOCAT_GITHUB_CLIENT_ID / AUTOCAT_GITHUB_CLIENT_SECRET
 *   AUTOCAT_PUBLIC_URL            (e.g. https://tv.example.com — the preview origin works too)
 *
 * Settings comes first and the environment second (`signinKeys` in `addon/settings.mjs`
 * settles that), so both a folder install with a form and a server with env vars work.
 *
 * The callback to register with each provider is `<AUTOCAT_PUBLIC_URL>/auth/<provider>/callback`,
 * and `redirectUri` below is the one function that says so — **the same string is shown in
 * Settings**, because a callback that is registered with a different host, port or trailing
 * slash is the failure this handshake cannot recover from. Without keys, signing in is *off*
 * and the profile pane says so — it never pretends to have a login it cannot finish. The
 * endpoint URLs themselves can be overridden (`AUTOCAT_GOOGLE_AUTHORIZE_URL`, … `_TOKEN_URL`,
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
import { cleanScope } from "./scope.mjs";

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
    authorize: () => env("AUTOCAT_GOOGLE_AUTHORIZE_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
    token: () => env("AUTOCAT_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
    userinfo: () => env("AUTOCAT_GOOGLE_USERINFO_URL", "https://openidconnect.googleapis.com/v1/userinfo"),
    scope: "openid email profile",
    // The OpenID userinfo answer is already the shape we want.
    read: (info) => ({ id: String(info.sub || ""), name: info.name || info.email || "", email: info.email || "", picture: info.picture || "" }),
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

/* ------------------------------------- this machine's own accounts (five per profile) */

/**
 * **This machine's own sign-in — and there are up to five of them per profile.**
 *
 * Google is the way in *when it is set up*, and a client id and secret are exactly what a
 * fresh install does not have. So the app keeps accounts of its own: a name and an optional
 * address, in `addon/account.json` (runtime state, git-ignored; `AUTOCAT_ACCOUNT_FILE` moves
 * it, which is how the tests stay out of the real one). It is not a second account system
 * beside the providers — it is the same session, the same cookie and the same `/auth/me`.
 *
 * **What changed: one account became five, and they are per profile.** A profile used to
 * hold the machine's single account, so switching from Male to Female showed the same
 * signed-in name — the account was the machine's, not the person's. Each profile now keeps
 * its **own** list of up to `MAX_LOCAL_ACCOUNTS` accounts, and choosing one files
 * *everything* under it: the app and the server both scope their stores by profile **and**
 * account (see `handleAddon` in `index.mjs`), so two accounts on one profile share nothing —
 * not a key, not a watchlist, not a card.
 *
 * The file holds every account on the machine:
 *
 *     { "accounts": [ { id, name, email, picture, profile, sessionId, since } ] }
 *
 * `profile` is the profile it was made under, `sessionId` is what makes the cookie survive
 * a restart, and nothing here is a password because there is nothing to verify against.
 */
const ACCOUNT_FILE = process.env.AUTOCAT_ACCOUNT_FILE || path.join(__dirname, "account.json");

/** How many local accounts one profile can hold. */
export const MAX_LOCAL_ACCOUNTS = 5;

/** `undefined` = not read yet; an array otherwise. */
let accountsCache;

/** The accounts on this machine, migrating the single-account file this used to write. */
function readAccounts() {
  if (accountsCache !== undefined) return accountsCache;
  try {
    const held = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
    if (Array.isArray(held?.accounts)) accountsCache = held.accounts.filter((a) => a && a.id && a.name);
    // The shape before this round: one account, no profile. It belongs to the first
    // profile (`you`), which is the profile that was on when it was made — and it is
    // **the account the app was already being used as**, so it adopts the files that were
    // there (see `takeAdoption` and `adoptScopeFiles` in `index.mjs`): an account that
    // starts empty would look like the app had thrown everything away.
    else if (held && held.id && held.name) accountsCache = [{ ...held, profile: held.profile || "you", adopt: true }];
    else accountsCache = [];
  } catch {
    accountsCache = [];
  }
  return accountsCache;
}

const writeAccounts = (list) => {
  accountsCache = list;
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE, `${JSON.stringify({ accounts: list }, null, 2)}\n`);
  } catch {
    // A machine that cannot write it still signs in for this run; the file is a
    // convenience, not the session itself.
  }
};

/** The public half of an account — never the session id. */
const publicAccount = (a) => ({ id: a.id, name: a.name, email: a.email || "", picture: a.picture || "", provider: "local" });

/** Every local account filed under one profile. */
/**
 * **Every profile starts with one account, and it is named.**
 *
 * The owner's ask: *"profile settings me pehla account default hoga aur pehle se bana milega —
 * pehle ka naam hoga male profile wale me adam and female profile wale account settings me eve"*.
 * A fresh install used to open Settings → Profile on an empty account list with a Name field in
 * it, so there was nothing to be signed in *as* until you had typed one — and the app is built
 * around a signed-in account (your pins, your Library, the pairing list). Each profile is given
 * its account on first sight: **Adam** for the first, **Eve** for the second, on this machine,
 * with no password and nothing sent anywhere. It is the same account the Name field would have
 * made, made for you.
 */
export function ensureDefaultAccount(profile = "") {
  const who = cleanProfile(profile);
  const mine = readAccounts().filter((a) => (a.profile || "you") === who);
  const name = who === "female" ? "Eve" : "Adam";
  // **The default account is there whether or not the profile holds others.** It used to be made
  // only for a profile with no accounts at all, so a profile that already had one of its own never
  // showed the default — the owner's *"adam account nahi aaya"*.
  if (mine.some((a) => a.name === name)) return false;
  // **An account the app is already using is not swapped out.** When the profile holds accounts,
  // the default is filed beside them and nothing is signed in as it; only a profile with nothing
  // at all gets the default signed in for it.
  if (mine.length) {
    const list = readAccounts();
    writeAccounts([...list, {
      id: `local-${randomBytes(6).toString("hex")}`,
      name,
      email: "",
      picture: "",
      profile: who,
      since: new Date().toISOString(),
    }]);
    return true;
  }
  signInLocal({ name, who: who === "you" ? "" : who });
  return true;
}

export const localAccounts = (profile = "") => {
  const who = cleanScope(profile) || "you";
  return readAccounts().filter((a) => (a.profile || "you") === who).map(publicAccount);
};

/** The local account that owns `id` (a session id), or null. */
const accountBySession = (id, profile = "") => {
  if (!id) return null;
  const who = profile ? cleanScope(profile) : "";
  return readAccounts().find((a) => a.sessionId === id && (!who || (a.profile || "you") === who)) || null;
};

/**
 * The account this browser is signed into **for one profile**.
 *
 * A session belongs to the account, and the account belongs to a profile: switching profile
 * must not show the other profile's name, which is the whole point of the split.
 */
export const localAccountFor = (req, profile = "") => {
  const held = accountBySession(cookieId(req), profile);
  return held ? publicAccount(held) : null;
};

/** Every account, for the profile pane that lists them (id + name only). */
export const cleanProfile = (profile) => cleanScope(profile) || "you";

const clean = () => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
};

/** The cookie the browser carries. HttpOnly, SameSite=Lax (the callback is a top-level GET). */
export const SESSION_COOKIE = "autocat_session";

const cookieId = (req) => {
  const raw = String(req.headers.cookie || "");
  const hit = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return hit ? hit.slice(SESSION_COOKIE.length + 1) : "";
};

export function readSession(req, profile = "") {
  clean();
  const id = cookieId(req);
  if (!id) return null;
  const found = sessions.get(id);
  if (found && (!profile || (found.profile || "you") === cleanProfile(profile))) return { ...found.user, expires: found.expires };
  // **A restart is not a sign-out for this machine's own account.** A provider's session
  // is a token this server was handed; this one is the machine's own, so the id it has
  // already accepted is written down and the cookie stands until the account is forgotten.
  const held = accountBySession(id, profile);
  if (held) {
    const user = publicAccount(held);
    const record = { user, profile: held.profile || "you", expires: Date.now() + SESSION_MS };
    sessions.set(id, record);
    return { ...user, expires: record.expires };
  }
  return null;
}

/** An address is optional here, so an empty one is fine — a wrong-looking one is not. */
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/**
 * Sign in on this machine: **switch to an account you already have, or make a new one.**
 *
 * - `id` names an account to come back as (that is what picking one off the list does).
 * - A `name` makes a new one, unless the profile is already holding `MAX_LOCAL_ACCOUNTS`
 *   of them — five is the limit, and the refusal says so rather than silently replacing one.
 * - Neither means "come back as the account this browser is already on for this profile"
 *   (the Continue button after a sign-out, one press, with nothing typed).
 *
 * A name that is only whitespace is not a name and is refused rather than stored, and so is
 * an address that is not one: that is the whole of the validation, because there is no
 * password and nothing to verify against.
 */
export function signInLocal({ name, email, id, who } = {}) {
  const profile = cleanProfile(who);
  const list = readAccounts();
  const mine = list.filter((a) => (a.profile || "you") === profile);

  if (id) {
    const found = mine.find((a) => a.id === cleanScope(id) || a.id === id);
    if (!found) throw new Error("That account is not on this machine.");
    const sessionId = found.sessionId || randomBytes(24).toString("base64url");
    const next = list.map((a) => (a.id === found.id ? { ...a, sessionId } : a));
    writeAccounts(next);
    sessions.set(sessionId, { user: publicAccount(found), profile, expires: Date.now() + SESSION_MS });
    return { user: publicAccount(found), sessionId, accounts: localAccounts(profile) };
  }

  const typed = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!typed) {
    const resume = mine[mine.length - 1] || null;
    if (!resume) throw new Error("A name is needed — that is the whole account.");
    const sessionId = resume.sessionId || randomBytes(24).toString("base64url");
    writeAccounts(list.map((a) => (a.id === resume.id ? { ...a, sessionId } : a)));
    sessions.set(sessionId, { user: publicAccount(resume), profile, expires: Date.now() + SESSION_MS });
    return { user: publicAccount(resume), sessionId, accounts: localAccounts(profile) };
  }
  if (mine.length >= MAX_LOCAL_ACCOUNTS) {
    throw new Error(`${profile} already holds ${MAX_LOCAL_ACCOUNTS} local accounts — that is the limit. Forget one first.`);
  }
  const address = String(email ?? "").trim().slice(0, 120);
  if (address && !looksLikeEmail(address)) throw new Error("That address does not look like one.");
  const user = { id: `local-${randomBytes(6).toString("hex")}`, name: typed, email: address, picture: "", profile };
  const sessionId = randomBytes(24).toString("base64url");
  writeAccounts([...list, { ...user, sessionId, since: new Date().toISOString() }]);
  sessions.set(sessionId, { user: publicAccount(user), profile, expires: Date.now() + SESSION_MS });
  return { user: publicAccount(user), sessionId, accounts: localAccounts(profile) };
}

/**
 * **The one account that adopts the app that was already there.**
 *
 * Before this round there was one account and no account scoping: everything was filed per
 * *profile*. The account carried over from that file is the one the app was being used as,
 * so it takes the profile's stores with it — the server copies every `*.you.json` to
 * `*.you-<id>.json` once, and the browser copies its own keys (see `adoptScopeFor` in the
 * app). Any account made after this one starts empty, which is what "separate" has to mean.
 */
export function takeAdoption(id) {
  const list = readAccounts();
  const found = list.find((a) => a.id === id && a.adopt);
  if (!found) return false;
  writeAccounts(list.map((a) => (a.id === id ? { ...a, adopt: false } : a)));
  return true;
}

/** Forget one of this machine's accounts, and the session that goes with it. */
export function forgetLocal(id = "") {
  const list = readAccounts();
  const wanted = String(id || "");
  const gone = wanted ? list.filter((a) => a.id === wanted) : list;
  for (const a of gone) if (a.sessionId) sessions.delete(a.sessionId);
  writeAccounts(wanted ? list.filter((a) => a.id !== wanted) : []);
  return true;
}

export const signOut = (req) => {
  const raw = String(req.headers.cookie || "");
  const hit = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (hit) sessions.delete(hit.slice(SESSION_COOKIE.length + 1));
};

/**
 * **The callback to register with the provider — one function, so the string cannot
 * drift.** `origin` is where the request came in; `AUTOCAT_PUBLIC_URL` wins when it is set,
 * which is what a server behind a proxy wants. The desktop app pins its port and sets
 * `AUTOCAT_PUBLIC_URL` to match (see `desktop/main.js`), because a callback registered
 * against a port the app picks at random each launch is a callback that stops working on
 * the next launch.
 */
export const redirectUri = (providerKey, origin) =>
  `${trimSlash(env("AUTOCAT_PUBLIC_URL") || origin)}/auth/${providerKey}/callback`;

/** Whether a provider can finish a sign-in right now (the same test the UI is given). */
const usable = (p) => Boolean(p && p.enabled?.() !== false && p.id() && p.secret());

/**
 * Where to send the browser to sign in.
 *
 * `origin` is where this request came in — the preview origin, a LAN address, the desktop
 * app's own localhost. It is only used when `AUTOCAT_PUBLIC_URL` is not set, and it is
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

  const headers = { authorization: `Bearer ${token.access_token}`, accept: "application/json", "user-agent": "AutoCAT" };
  const info = await (await fetch(p.userinfo(), { headers })).json();
  const user = p.read(info);
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
