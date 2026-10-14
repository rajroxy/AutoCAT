/**
 * Minimal TMDB client for the AutoCAT catalog addon.
 *
 * - Reads the key from TMDB_API_KEY (v3 key or v4 read token — both accepted).
 * - Caches every response in memory so a home screen full of catalog rows only
 *   costs a handful of upstream calls per TTL window.
 * - Resolves genre and keyword *names* to TMDB ids at runtime, so nothing here
 *   depends on hard-coded id tables that can drift.
 */

import { activeLanguage, activeRefreshMinutes } from "./settings.mjs";

/**
 * Where TMDB lives.
 *
 * `TMDB_BASE_URL` overrides it, the same way `AUTOCAT_GOOGLE_AUTHORIZE_URL` overrides the
 * provider endpoint in `addon/auth.mjs` — it is how the test suite points the whole client
 * at a stand-in and checks what a row really asks for, instead of taking a description of
 * it on trust. Read once, at import: the app itself never sets it.
 */
const BASE = process.env.TMDB_BASE_URL || "https://api.themoviedb.org/3";

/**
 * How long a TMDB response is reused.
 *
 * Settings → Refresh decides it, so "update the catalogs every hour" also means
 * "the addon may see new data every hour". With the refresh set to 0 ("only when
 * you ask") a response is kept for a day, so nothing changes behind the user's
 * back. `TMDB_CACHE_TTL_MS` still overrides both — that is what the probes and
 * the tests use.
 */
const ENV_TTL_MS = Number(process.env.TMDB_CACHE_TTL_MS) || 0;
const ttlMs = () => {
  if (ENV_TTL_MS > 0) return ENV_TTL_MS;
  const minutes = activeRefreshMinutes();
  return minutes > 0 ? minutes * 60_000 : 24 * 60 * 60 * 1000;
};

export const IMG = "https://image.tmdb.org/t/p";

// Stremio calls the type "series"; TMDB calls it "tv". Every TMDB path must use
// this mapping — using the Stremio type verbatim silently 404s every TV query.
export const tmdbPath = (media) => (media === "movie" ? "movie" : "tv");

const cache = new Map();

// The key can come from Settings at runtime (the addon's settings store) or from
// the environment. Settings wins, so pasting a key in the app takes effect
// immediately without a restart.
let overrideKey = "";
export function setKey(key) {
  const next = String(key || "");
  if (next !== overrideKey) {
    overrideKey = next;
    cache.clear();
  }
}

const apiKey = () => overrideKey || process.env.TMDB_API_KEY || "";

export function hasKey() {
  return Boolean(apiKey());
}

/**
 * **Drop every cached TMDB response.**
 *
 * A provider's answer is cached for the session, so turning enrichment on or off
 * changed nothing on screen: the rows were still the rows read before the switch. The
 * settings route calls this whenever enrichment, posters or providers change, and the
 * next request rebuilds from TMDB with the new answer.
 *
 * **The app's own refresh calls it too.** Pressing Home or the chosen Movies / Shows plate
 * re-reads every row on the screen; without the drop the addon answered those re-reads out
 * of this map, so the catalogs and the card posters came back identical and the press looked
 * like it had done nothing (see `/refresh.json`).
 */
export function clearTmdbCache() {
  cache.clear();
}

/**
 * The content language rides on every request that returns titles, so changing
 * it in Settings localises every row at once. The genre *list* is excluded: genre
 * names are resolved to TMDB ids by their English names, and a localised list
 * would stop `<Genre>` rows resolving. The cache is dropped when the language
 * changes, so a switch is never served from the previous language.
 */
let cachedLanguage = null;
function contentLanguage() {
  const next = activeLanguage();
  if (next !== cachedLanguage) {
    cachedLanguage = next;
    cache.clear();
  }
  return next;
}

async function request(path, params = {}) {
  // Re-read the key each call so a Settings change is picked up at once.
  const language = contentLanguage();
  const query = language && params.language === undefined && !path.startsWith("/genre/")
    ? { ...params, language }
    : params;
  const keyName = path + "?" + JSON.stringify(query);
  const hit = cache.get(keyName);
  if (hit && hit.expires > Date.now()) return hit.value;

  const key = apiKey();
  if (!key) throw new Error("TMDB_API_KEY is not set");

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  // v4 read tokens are long JWTs; v3 keys are short hex strings.
  const headers = { accept: "application/json" };
  if (key.length > 60) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} for ${path}${body ? ` — ${body.slice(0, 160)}` : ""}`);
  }
  const json = await res.json();
  cache.set(keyName, { value: json, expires: Date.now() + ttlMs() });
  return json;
}

export const get = request;

/** name → id maps, cached per media type. */
const genreCache = new Map();

export async function genres(media) {
  const hit = genreCache.get(media);
  if (hit && hit.expires > Date.now()) return hit.value;
  const res = await request(`/genre/${tmdbPath(media)}/list`);
  const value = res.genres ?? [];
  genreCache.set(media, { value, expires: Date.now() + ttlMs() });
  return value;
}

const genreId = new Map(); // "media:Name" -> id
const keywordId = new Map();

export async function resolveGenre(media, name) {
  const k = `${media}:${name.toLowerCase()}`;
  if (genreId.has(k)) return genreId.get(k);
  const all = await genres(media);
  const found = all.find((g) => g.name.toLowerCase() === name.toLowerCase());
  const id = found ? found.id : null;
  genreId.set(k, id);
  return id;
}

export async function resolveKeyword(name) {
  const k = name.toLowerCase();
  if (keywordId.has(k)) return keywordId.get(k);
  try {
    const res = await request("/search/keyword", { query: name });
    const id = res.results?.[0]?.id ?? null;
    keywordId.set(k, id);
    return id;
  } catch {
    keywordId.set(k, null);
    return null;
  }
}

/** TMDB list item → Stremio/AutoCAT meta. */
export function toMeta(item, type) {
  if (!item || !item.id) return null;
  const isMovie = type === "movie";
  const date = isMovie ? item.release_date : item.first_air_date;
  const meta = {
    id: `tmdb:${item.id}`,
    type,
    name: (isMovie ? item.title : item.name) || item.original_title || item.original_name || "Untitled",
    posterShape: "poster",
  };
  if (item.poster_path) meta.poster = `${IMG}/w500${item.poster_path}`;
  if (item.backdrop_path) meta.background = `${IMG}/w780${item.backdrop_path}`;
  if (date) { meta.releaseInfo = String(date).slice(0, 4); meta.releaseDate = String(date).slice(0, 10); }
  if (typeof item.vote_average === "number" && item.vote_average > 0) {
    meta.imdbRating = item.vote_average.toFixed(1);
  }
  const embed = process.env.AUTOCAT_STREAM_SOURCE;
  if (embed) meta.behaviorHints = { defaultVideoId: `tmdb:${item.id}` };
  if (item.overview) meta.description = item.overview;
  // The flag travels with the meta so any list can be filtered against the SFW
  // switch — TMDB ignores `include_adult` on several endpoints, so trusting the
  // query alone is what let adult titles through.
  if (item.adult) meta.adult = true;
  return meta;
}
