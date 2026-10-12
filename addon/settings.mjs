/**
 * Settings store for the app.
 *
 * The desktop/browser UI keeps its own copy in localStorage for instant, offline
 * feedback; the provider and tracking *keys* are also written here so the addon
 * (the thing that actually talks to upstream providers) can use them. Nothing is
 * committed — `addon/settings.json` is git-ignored and created at runtime.
 *
 * The public view never returns a key verbatim, only whether one is set.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so tests never touch the real settings file.
const FILE = process.env.NUVIO_SETTINGS_FILE || path.join(__dirname, "settings.json");

const DEFAULTS = {
  profile: "VOD",
  safe: true,
  // The **Custom** card's label. The card holds your own list; what it is called
  // is yours to say, so the name is a setting rather than a constant in the card
  // set (which is shared by the addon and the cover generator).
  customLabel: "Library",
  // The language every row is served in (TMDB's `language`), and the primary
  // subtitle language the app and a player should prefer — one setting, because
  // you want your subtitles in the language you browse in.
  language: process.env.NUVIO_LANGUAGE || "en-US",
  // Where you are. This is the region the OTT rows are scoped to: the three
  // regional cards show *your* country's services, and the global platform rows
  // report availability for it.
  country: (process.env.NUVIO_REGION || "US").toUpperCase(),
  // How often catalogs and metadata are re-read from TMDB. `minutes` is the
  // refresh interval; 0 means "only when you ask". The addon's own response
  // cache follows it and the app re-reads the screen on the same clock, so one
  // setting drives both halves of "update itself".
  refresh: { minutes: 60 },
  // Providers that can supply catalogs and metadata. Enabling one switches the
  // addon onto it for the parts it supports; catalog names never change.
  providers: {
    tmdb: { enabled: true, key: "" },
    tvdb: { enabled: false, key: "" },
    mdblist: { enabled: false, key: "" },
  },
  // **Debrid turns a torrent into an ordinary HTTPS link.** This is what makes
  // torrent streams play at all from the app: a browser's own torrent engine can
  // only reach peers that speak WebRTC, which the public swarms barely have, so a
  // magnet usually sits at "looking for peers" forever. A debrid service downloads
  // the torrent on its own servers and hands back a direct URL the video element
  // plays like any other stream — instant when someone else already cached it.
  //
  // Ordered the way they are tried: the first enabled service with a key answers.
  // `key` is the user's API token; it never leaves the server (see
  // `publicSettings`, which reports only whether one is set).
  debrid: {
    realdebrid: { enabled: false, key: "" },
    alldebrid: { enabled: false, key: "" },
    premiumize: { enabled: false, key: "" },
    torbox: { enabled: false, key: "" },
    // The three below round out the set the wider Stremio/add-on ecosystem speaks:
    // Debrid-Link (Europe's biggest), Deepbrid (its own documented REST API) and
    // Put.io (a cloud that plays torrents, with no plain-HTTP hoster side at all).
    debridlink: { enabled: false, key: "" },
    deepbrid: { enabled: false, key: "" },
    putio: { enabled: false, key: "" },
  },
  // **Subtitles for a stream that carries the wrong ones.** Plenty of streams carry
  // no subtitle track at all, or carry one language and not yours; OpenSubtitles is
  // the catalogue the player searches to fill that gap. `language` is the language it
  // looks in — empty means "the language you browse in" (`language` above), because
  // wanting your subtitles in the language you read the app in is the whole point of
  // it. The username/password half is optional: it raises the daily download quota and
  // is the only way to download at all once OpenSubtitles asks for a signed-in user.
  // Both halves never leave the server, like every other key here.
  subtitles: {
    // Ordered the way they are searched: OpenSubtitles first (widest coverage, and
    // the only one whose downloads work without a paid tier), then the ones that
    // reach titles it is missing. Each holds its own key; a service is asked only
    // when it is switched on and holds one.
    opensubtitles: { enabled: false, key: "", username: "", password: "" },
    subdl: { enabled: false, key: "" },
    subsource: { enabled: false, key: "" },
    wyzie: { enabled: false, key: "" },
    language: "",
  },
  // Who supplies the content you see inside a row. TMDB is the only provider that
  // can generate a row (its discover endpoint is what answers "90s action on
  // Netflix"); TVDB can supply a title's name, translation, year and artwork for
  // every row. "tvdb" therefore re-sources the *content* of every catalog from
  // TVDB and needs the TVDB provider enabled with a key, or it falls back.
  content: { source: "tmdb" },
  // **Enrichment, not a content source.** TMDB and TVDB work together: TMDB builds
  // every row, TVDB fills the fields TMDB left empty for the same title (keyed by
  // IMDb id). Each half can be switched off from Settings → Trackers & providers.
  enrich: { tmdb: true, tvdb: true },
  // Live TV & Sports: where the lineup and the guide come from. "dth" is the
  // **premium/DTH provider catalogue** shipped with the app ("m3u" is your own
  // playlist URL/file, "xtream" is an Xtream Codes login). `providers` is which of
  // the catalogue's operators this profile is drawn from, and `epg` is an XMLTV URL
  // — with it (or a provider's own public feed) the Guide draws real programme
  // blocks; without it the lineup is still there and the Guide says so.
  live: {
    mode: "dth",
    m3u: "",
    host: "",
    username: "",
    password: "",
    epg: "",
    providers: [],
    // 0 → follow the content refresh interval above.
    refreshMinutes: 0,
  },
  // Tracking services (watched history, scrobbling). Stored for the native app.
  // The anime databases track the same shows as the film ones, so they sit in the
  // same group; the drama tracker is its own catalogue and its own group.
  tracking: {
    trakt: { enabled: false, key: "" },
    simkl: { enabled: false, key: "" },
    myanimelist: { enabled: false, key: "" },
    anilist: { enabled: false, key: "" },
    mydramalist: { enabled: false, key: "" },
  },
  // **Sign in — Google and GitHub.** Each needs a client id and a client secret, and
  // the **secret never leaves this file** (see `publicSettings`: the id is reported
  // verbatim because it is public by design — it travels in the authorize URL — and the
  // secret only as a boolean). They live in Settings rather than only in the environment
  // because a machine that runs this app from a folder has nowhere else to put them, and
  // a provider with no keys is a button that cannot finish a sign-in. `signinKeys` reads
  // this first and the environment second, so `NUVIO_GOOGLE_CLIENT_ID` and friends work
  // exactly as they did. `enabled` is the switch every other provider row has: off, the
  // provider is not offered even with keys set.
  signin: {
    google: { enabled: true, clientId: "", clientSecret: "" },
    github: { enabled: true, clientId: "", clientSecret: "" },
  },
  // Add-ons and plugins the user added. They live **on the server**, not only in the
  // page, because reading a stream needs a server-side request: a browser cannot
  // call another host's `/stream/...` unless that host sends permissive CORS
  // headers, which most add-ons do not. Nothing here is a secret — a source is a
  // URL — so they travel back to the page verbatim.
  sources: [],
  // Poster artwork. **Off by default, and the choice is one of three.** The artwork
  // the providers serve is already 2:3 and tagged with the year — a poster service is
  // for the people who want the artwork *replaced* by one carrying its ratings, so it
  // is a deliberate pick rather than something already on. The pattern is still free
  // text, so a service this app has never heard of can be dropped in; `{imdb_id}`,
  // `{tmdb_id}`, `{type}` and `{rpdb_key}` are filled in per title.
  posters: {
    enabled: false,
    source: "none",
    pattern: "",
    apiKey: "",
  },
  // Which ratings the title page shows. `none` hides the row, `free` reads IMDb /
  // Rotten Tomatoes / Metacritic from their public pages with no key, and `mdblist`
  // adds the aggregate (one key, many sources). TMDB's own score is always shown —
  // it arrives with the title.
  ratings: {
    source: "free",
  },
  ai: {
    enabled: true,
    // Which free provider answers the Ask box (`""` = plain text search). The
    // catalogue of providers lives in `addon/ai.mjs`; these are just the user's
    // choice and their keys, kept server-side for the same reason as the rest: a
    // key must never be readable from the page.
    provider: "groq",
    keys: { groq: "", google: "", openrouter: "", cerebras: "" },
    // Optional model override — providers rename models faster than this ships.
    model: "",
    // "Pick for me": which row the Ask box searches. Empty means both, so the
    // box behaves as it always did until you choose a side.
    pickRow: "",
    // "Classic posters & banners" → high-quality modern artwork.
    enhanceArtwork: true,
    // Apply that same treatment to titles the poster service could not cover.
    enhanceMissing: true,
  },
};

let cache = null;

// The two profiles were renamed: `Movies & Shows` → `VOD` and `Live TV & Sports` →
// `IPTV`. A settings file written before that still holds the old word, so it is
// mapped on the way in — the new name is what the app is told and what gets written.
const PROFILE_RENAME = { "Movies & Shows": "VOD", "Live TV & Sports": "IPTV" };
const currentProfile = (name) => PROFILE_RENAME[name] || (["VOD", "IPTV"].includes(name) ? name : "VOD");

function merge(base, next) {
  for (const [k, v] of Object.entries(next || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") merge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

function load() {
  if (cache) return cache;
  try {
    cache = merge(structuredClone(DEFAULTS), JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  cache.profile = currentProfile(cache.profile);
  return cache;
}

export const getSettings = () => load();

export function updateSettings(patch) {
  const next = merge(load(), patch || {});
  cache = next;
  try {
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n");
  } catch {
    /* read-only fs — keep the in-memory copy */
  }
  return next;
}

/** Keys are never returned verbatim — only whether they are set. */
export function publicSettings() {
  const s = load();
  // Only the services this build offers — an old settings file that still holds
  // a retired tracker (AniList) must not put it back in the UI.
  const mask = (group) =>
    Object.fromEntries(
      Object.keys(DEFAULTS[group] || {}).map((k) => [k, { enabled: Boolean(s[group]?.[k]?.enabled), hasKey: Boolean(s[group]?.[k]?.key) }]),
    );
  return {
    profile: s.profile,
    safe: s.safe,
    customLabel: String(s.customLabel ?? DEFAULTS.customLabel).slice(0, 40),
    refresh: { minutes: activeRefreshMinutes() },
    language: s.language || DEFAULTS.language,
    country: String(s.country || DEFAULTS.country).toUpperCase(),
    content: { source: s.content?.source === "tvdb" ? "tvdb" : "tmdb" },
    // The live source is reported as *what is set*, never as the values: a
    // playlist URL can carry a token and a password is a password.
    live: {
      mode: ["dth", "m3u", "xtream"].includes(s.live?.mode) ? s.live.mode : "dth",
      providers: Array.isArray(s.live?.providers) ? s.live.providers : [],
      hasM3u: Boolean(s.live?.m3u),
      hasLogin: Boolean(s.live?.host && s.live?.username),
      hasEpg: Boolean(s.live?.epg),
      refreshMinutes: Number(s.live?.refreshMinutes) || 0,
    },
    providers: mask("providers"),
    tracking: mask("tracking"),
    debrid: mask("debrid"),
    // **The sign-in pair, half public and half masked.** A client id is in the URL the
    // browser is sent to, so it is handed back verbatim — the page shows it and the
    // callback it belongs with. The secret is never returned; the page only learns
    // whether one is set, the same rule as every other key here.
    signin: Object.fromEntries(
      Object.keys(DEFAULTS.signin).map((k) => {
        // The pair **as it is in effect** — Settings first, the environment second — so
        // the page shows the id a sign-in would actually use, whether it was pasted here
        // or set as `NUVIO_GOOGLE_CLIENT_ID` on the machine.
        const { id, secret, enabled } = signinKeys(k);
        return [k, { enabled, clientId: id.slice(0, 200), hasSecret: Boolean(secret) }];
      }),
    ),
    // OpenSubtitles is not a plain `mask()` group: the login is a second secret on
    // the same row, so it is reported the same way a key is — as a boolean.
    subtitles: {
      // One entry per service, each masked exactly like a provider group: whether it
      // is switched on, and whether a key is set — never the key. OpenSubtitles adds
      // `hasLogin`, because its download step is the part that wants an account.
      ...Object.fromEntries(
        SUBTITLE_SERVICES.map((name) => {
          const sv = s.subtitles?.[name] || {};
          const env = SUBTITLE_ENV[name] || {};
          const masked = {
            enabled: sv.enabled === true,
            hasKey: Boolean(sv.key) || Boolean(env.key && process.env[env.key]),
          };
          if (name === "opensubtitles") {
            masked.hasLogin =
              Boolean(sv.username && sv.password) ||
              Boolean(process.env.OPENSUBTITLES_USERNAME && process.env.OPENSUBTITLES_PASSWORD);
          }
          return [name, masked];
        }),
      ),
      language: subtitleLanguage(),
      // The names of the services that would actually be searched right now, so the
      // player can say which catalogue a result came from.
      services: subtitleServices().map((x) => x.name),
      ready: subtitlesReady(),
    },
    // Both halves of the enrichment, so the app's two switches are read back from the
    // server rather than only from the page's own copy. They are booleans, so this is
    // the one provider-shaped block that travels verbatim.
    enrich: { tmdb: s.enrich?.tmdb !== false, tvdb: s.enrich?.tvdb !== false },
    sources: Array.isArray(s.sources) ? s.sources : [],
    posters: {
      enabled: s.posters?.enabled !== false,
      source: s.posters?.source || "none",
      pattern: s.posters?.pattern || "",
      hasKey: Boolean(s.posters?.apiKey),
    },
    // Which ratings service the title page is reading. One word, so it travels
    // verbatim; the MDBList key itself is masked with the other provider keys.
    ratings: {
      source: ["none", "free", "mdblist"].includes(s.ratings?.source) ? s.ratings.source : "free",
    },
    // The AI keys are masked into a `hasKey` map as well — returning `s.ai`
    // verbatim (as this used to) would have shipped every pasted AI key to the
    // browser.
    ai: {
      enabled: s.ai?.enabled !== false,
      provider: s.ai?.provider || "",
      model: s.ai?.model || "",
      pickRow: s.ai?.pickRow === "movie" || s.ai?.pickRow === "series" ? s.ai.pickRow : "",
      hasKey: Object.fromEntries(
        Object.keys(DEFAULTS.ai.keys).map((k) => [k, Boolean(s.ai?.keys?.[k])]),
      ),
      enhanceArtwork: s.ai?.enhanceArtwork !== false,
      enhanceMissing: s.ai?.enhanceMissing !== false,
    },
  };
}

const DEFAULT_POSTER_PATTERN = "https://api.ratingposterdb.com/{rpdb_key}/imdb/poster-default/{imdb_id}.jpg";

/** The content language every row is served in. */
export const activeLanguage = () => load().language || process.env.NUVIO_LANGUAGE || "en-US";

/**
 * How often catalogs and metadata are allowed to come back new, in minutes.
 *
 * The known choices are 15 / 30 / 60 / 180, and 0 for "only when you ask" (the
 * app's manual refresh). Anything else falls back to the default, so a hand-edited
 * settings file cannot leave the cache with a nonsense lifetime.
 */
export const activeRefreshMinutes = () => {
  const n = Number(load().refresh?.minutes);
  if (!Number.isFinite(n) || n < 0) return 60;
  return n;
};

/** The country whose services the OTT rows show. */
export const activeCountry = () => String(load().country || process.env.NUVIO_REGION || "US").toUpperCase();

/** The provider asked to supply catalog content ("tmdb" unless TVDB is chosen). */
export const activeContentSource = () => (load().content?.source === "tvdb" ? "tvdb" : "tmdb");

/**
 * **One provider's sign-in pair: Settings first, then the environment.**
 *
 * The client id is public (it is in the URL the browser is sent to) and the secret is
 * not, and both are asked for by name here rather than read where they are used, so
 * `addon/auth.mjs` never has to know where a key came from. `enabled` is the row's own
 * switch: with it off, a pair that is set is not offered as a way in.
 */
const SIGNIN_ENV = {
  google: ["NUVIO_GOOGLE_CLIENT_ID", "NUVIO_GOOGLE_CLIENT_SECRET"],
  github: ["NUVIO_GITHUB_CLIENT_ID", "NUVIO_GITHUB_CLIENT_SECRET"],
};

export function signinKeys(provider) {
  const held = load().signin?.[provider] || {};
  const [idEnv, secretEnv] = SIGNIN_ENV[provider] || [];
  const id = String(held.clientId || "").trim() || (idEnv ? String(process.env[idEnv] || "").trim() : "");
  const secret = String(held.clientSecret || "").trim() || (secretEnv ? String(process.env[secretEnv] || "").trim() : "");
  return { id, secret, enabled: held.enabled !== false };
}

/** The effective TMDB key: the one set in Settings first, then the environment. */
export const tmdbKey = () => load().providers?.tmdb?.key || process.env.TMDB_API_KEY || "";

/**
 * Effective keys for the optional metadata providers.
 *
 * A key can come from the app (Settings → Providers, which also has an enable
 * switch) **or from the environment**. The environment counts as enabled: a key set
 * in Settings → Environment is a key the user deliberately added, and one that did
 * nothing because an in-app switch they never saw was off is a key that looks
 * broken. **MDBList is what carries the many-service ratings** — IMDb, Trakt,
 * Letterboxd, Rotten Tomatoes, Metacritic — so without it the title page can only
 * show TMDB's own score.
 */
/**
 * The debrid services to try, in order, as `{ name, key }`.
 *
 * A service counts when it is switched on **and** holds a key, or when its key is in
 * the environment — the same rule as the metadata providers: a key the user
 * deliberately exported is a key, and one that did nothing because an in-app switch
 * they never opened was off is a key that looks broken.
 */
export const DEBRID_ENV = {
  realdebrid: "REALDEBRID_API_KEY",
  alldebrid: "ALLDEBRID_API_KEY",
  premiumize: "PREMIUMIZE_API_KEY",
  torbox: "TORBOX_API_KEY",
  debridlink: "DEBRIDLINK_API_TOKEN",
  deepbrid: "DEEPBRID_API_KEY",
  putio: "PUTIO_API_TOKEN",
};

export function debridServices() {
  const d = load().debrid || {};
  return Object.keys(DEBRID_ENV)
    .map((name) => {
      const saved = d[name];
      const key = saved?.enabled && saved.key ? saved.key : process.env[DEBRID_ENV[name]] || "";
      return { name, key };
    })
    .filter((s) => Boolean(s.key));
}

/** The key a single debrid service would use, whether or not it is switched on. */
export function debridKey(name) {
  const saved = load().debrid?.[name];
  return (saved?.enabled && saved.key ? saved.key : "") || process.env[DEBRID_ENV[name]] || "";
}

/* ----------------------------------------------------------------- subtitles */

/**
 * **The subtitle services this build offers**, in the order they are searched.
 *
 * OpenSubtitles leads: it has the widest catalogue and is the only service here whose
 * downloads work without a paid tier. The rest exist because a title OpenSubtitles is
 * missing is often present somewhere else — SubDL and SubSource carry a great deal of
 * television and regional releases, and Wyzie is an aggregator that reaches several of
 * the smaller sites at once. Each needs its own key, and a service is asked only when
 * it is switched on and holds one.
 */
export const SUBTITLE_SERVICES = ["opensubtitles", "subdl", "subsource", "wyzie"];

export const SUBTITLE_LABELS = {
  opensubtitles: "OpenSubtitles",
  subdl: "SubDL",
  subsource: "SubSource",
  wyzie: "Wyzie",
};

/**
 * Where each service's secret may come from in the environment.
 *
 * OpenSubtitles carries a second secret — the login its downloads need; the others are
 * key-only. The same rule as every other key in this file: something set in Settings
 * counts when it is switched on, and a key in the environment counts on its own — a key
 * the user deliberately exported must not do nothing because an in-app switch they never
 * opened was off.
 */
export const SUBTITLE_ENV = {
  opensubtitles: { key: "OPENSUBTITLES_API_KEY", username: "OPENSUBTITLES_USERNAME", password: "OPENSUBTITLES_PASSWORD" },
  subdl: { key: "SUBDL_API_KEY" },
  subsource: { key: "SUBSOURCE_API_KEY" },
  wyzie: { key: "WYZIE_API_KEY" },
};

/** OpenSubtitles' three secrets, kept as its own export for the engine and its tests. */
export const OPENSUBTITLES_ENV = SUBTITLE_ENV.opensubtitles;

/** One subtitle service's credentials, Settings first and the environment second. */
export function subtitleService(name) {
  const saved = load().subtitles?.[name] || {};
  const env = SUBTITLE_ENV[name] || {};
  const fromEnv = (field) => (env[field] ? process.env[env[field]] || "" : "");
  const pick = (field) => (saved.enabled && saved[field] ? saved[field] : "") || fromEnv(field);
  const key = pick("key");
  const username = pick("username");
  const password = pick("password");
  const on = saved.enabled === true || Boolean(fromEnv("key"));
  const ready = Boolean(key && on);
  return {
    name,
    label: SUBTITLE_LABELS[name] || name,
    key,
    username,
    password,
    enabled: on,
    ready,
    // Everything is downloadable with a key except OpenSubtitles, whose downloads are
    // the step that wants a signed-in account.
    canDownload: ready && (name !== "opensubtitles" || Boolean(username && password)),
  };
}

/** Every subtitle service that is switched on and holds a key, in search order. */
export const subtitleServices = () => SUBTITLE_SERVICES.map(subtitleService).filter((s) => s.ready);

/** Is there a subtitle service ready to search with? */
export const subtitlesReady = () => subtitleServices().length > 0;

/**
 * The OpenSubtitles credentials in the shape `addon/subtitles.mjs` has always consumed.
 */
export function opensubtitles() {
  const s = subtitleService("opensubtitles");
  return { key: s.key, username: s.username, password: s.password, ready: s.ready, canDownload: s.canDownload };
}

/**
 * The language subtitles are searched in, as an ISO-639-1 code.
 *
 * Empty (or nonsense) follows the language the app is browsed in — `en-US` becomes
 * `en`. A two-letter code the user picked is used as-is, because OpenSubtitles keys
 * its catalogue by that code and nothing else.
 */
export const subtitleLanguage = () => {
  const picked = String(load().subtitles?.language || "").trim().toLowerCase();
  if (/^[a-z]{2}$/.test(picked)) return picked;
  return String(load().language || "en-US").slice(0, 2).toLowerCase();
};

export const providerKeys = () => {
  const p = load().providers || {};
  const pick = (name, envName) => {
    const saved = p[name];
    if (saved?.enabled && saved.key) return saved.key;
    return process.env[envName] || "";
  };
  return { tvdb: pick("tvdb", "TVDB_API_KEY"), mdblist: pick("mdblist", "MDBLIST_API_KEY") };
};
