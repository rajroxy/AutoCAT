/**
 * Subtitles: the tracks a stream does not carry.
 *
 * ## Why this exists
 *
 * A stream can carry no subtitle track at all, or one language and not the one you
 * read. The player's own Audio & subtitles panel can only list *what the stream
 * carries* — for everything else there has to be a catalogue to search, and this module
 * is the half of that which cannot run in a page: the APIs need keys that must never
 * reach the browser, several of them refuse cross-origin reads, and the files they hand
 * back are usually **ZIP or gzip**. So the search and the fetch both happen here, and the
 * browser receives something it can attach straight to a `<track>`: **WebVTT text**.
 *
 * ## Several services, one result list
 *
 * There is no single catalogue that has everything, so this build searches several:
 *
 *   opensubtitles  the widest coverage; the only one whose downloads need a login
 *   subdl          strong on TV and regional releases (its own API key)
 *   subsource      another broad catalogue behind one key
 *   wyzie          an aggregator that reaches several smaller sites at once
 *
 * Each provider implements the same small contract —
 *
 *   search({ imdb, tmdb, type, season, episode, name, year, language, limit })
 *   download(ref, { language, name })
 *
 * — and `searchSubtitles` asks every enabled one, tags each result with the service it
 * came from, and hands the page one merged list. A service that fails says so without
 * hiding the ones that worked.
 *
 * ## Reference tokens, not ids
 *
 * The page is given a short **token** per result rather than a provider's own id, and the
 * token maps back to whatever the provider's download step needs — SubDL's real handle is
 * a file path and Wyzie's is a full URL, neither of which belongs in a URL path. The token
 * is what `/subtitles/<service>/<token>.vtt` resolves, so the browser always reads the
 * subtitle from this server: same-origin, already converted, seekable.
 *
 * ## What is cached
 *
 * A search answer for ten minutes (a title page is opened and closed constantly), and
 * **the decoded WebVTT by service+token** — a download can cost quota, and re-picking the
 * subtitle you already tried must not spend a second one. OpenSubtitles' session token is
 * cached too, and re-minted on a 401 rather than on a clock: it documents no lifetime, so
 * the only trustworthy signal is the API refusing it.
 */
import zlib from "node:zlib";
import { subtitleServices, subtitleService, subtitleLanguage } from "./settings.mjs";

const UA = process.env.NUVIO_OPENSUBTITLES_UA || "AutoCAT v1.0";
const TIMEOUT_MS = Number(process.env.NUVIO_SUBTITLES_TIMEOUT_MS) || 20000;
const SEARCH_TTL_MS = Number(process.env.NUVIO_SUBTITLES_TTL_MS) || 10 * 60 * 1000;

/**
 * The languages Settings offers, as `[code, label]`.
 *
 * Each API keys its catalogue by this two-letter code (Wyzie and SubDL) or by the English
 * name (SubSource), so this list is the vocabulary the app publishes and every provider
 * translates from — the app's own `language` setting is a TMDB locale (`en-US`) and its
 * first two letters are the code.
 */
export const SUBTITLE_LANGUAGES = [
  ["en", "English"], ["hi", "Hindi"], ["bn", "Bengali"], ["ta", "Tamil"], ["te", "Telugu"],
  ["ml", "Malayalam"], ["kn", "Kannada"], ["mr", "Marathi"], ["pa", "Punjabi"], ["ur", "Urdu"],
  ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["nl", "Dutch"], ["ru", "Russian"], ["uk", "Ukrainian"], ["pl", "Polish"], ["tr", "Turkish"],
  ["ar", "Arabic"], ["fa", "Persian"], ["he", "Hebrew"], ["el", "Greek"], ["ro", "Romanian"],
  ["hu", "Hungarian"], ["cs", "Czech"], ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"],
  ["fi", "Finnish"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["id", "Indonesian"],
  ["ms", "Malay"], ["th", "Thai"], ["vi", "Vietnamese"],
];

const now = () => Date.now();
const digits = (v) => String(v || "").replace(/[^0-9]/g, "");

/* ------------------------------------------------------- reference tokens & caches */

/** "service:token" -> the payload that service's download call needs. */
const refs = new Map();
let seq = 0;
const remember = (provider, ref) => {
  const token = `s${++seq}`;
  refs.set(`${provider}:${token}`, ref);
  return token;
};
const recall = (provider, token) => refs.get(`${provider}:${token}`);

/** "service:params" -> { value, expires } */
const searches = new Map();
/** "service:token" -> the decoded WebVTT */
const files = new Map();

/* --------------------------------------------------------------------- fetch bits */

/**
 * `fetch` with a deadline, a descriptive User-Agent and a JSON body option.
 *
 * Every API here sits behind a CDN; the abort is what keeps one dead provider from
 * holding the whole panel open for a minute.
 */
async function fetchJson(url, { method = "GET", headers = {}, body, sign = "" } = {}) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "user-agent": UA,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
        ...(sign ? { authorization: `Bearer ${sign}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "follow",
      signal: control.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* a non-JSON body is reported as raw text by the callers that care */
    }
    return { res, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** A provider that is switched off says so the same way everywhere. */
const notReady = (name) => ({
  ok: false,
  results: [],
  message: `No ${subtitleService(name).label} key is set — add one in Settings → Subtitles.`,
});

/* ------------------------------------------------------------------------ text bits */

/**
 * The first subtitle entry in a ZIP.
 *
 * Most of these services serve their files zipped, and the project ships no zip
 * dependency — so the central directory is walked here (PKZIP APPNOTE layouts) and the
 * one entry that can be a subtitle is inflated with `zlib.inflateRawSync`, which is what
 * a ZIP's "deflate" method actually is (raw DEFLATE, not zlib-wrapped). Anything
 * unexpected returns nothing rather than a corrupt track: a wrong subtitle file should
 * fail out loud, not scroll garbage over the picture.
 */
function fromZip(buf) {
  const eocd = (() => {
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  })();
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.(srt|vtt|sub|ass|ssa)$/i.test(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compressed);
    if (method === 0) return { name, text: data };
    if (method === 8) return { name, text: zlib.inflateRawSync(data) };
    return null;
  }
  return null;
}

/** Gzip, ZIP, or plain bytes — decoded into one UTF-8 (or Latin-1) string. */
function unwrap(buf, hintedName = "") {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return { name: hintedName, text: zlib.gunzipSync(buf) };
  }
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const entry = fromZip(buf);
    if (!entry) throw new Error("the ZIP held no subtitle file this server can read");
    return entry;
  }
  return { name: hintedName, text: buf };
}

/** Bytes to text. Latin-1 is the fallback: it cannot fail, and SRTs are full of it. */
function decode(buf) {
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  return buf.toString("latin1");
}

/** SRT (or ASS) text into the WebVTT the browser's `<track>` element requires. */
export function toVtt(input) {
  const text = String(input || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (/^\s*WEBVTT/.test(text)) return `${text.trimEnd()}\n`;

  const strip = (line) => line.replace(/\{[^}]*\}/g, "").replace(/\\N/gi, "\n").replace(/<font[^>]*>/gi, "").replace(/<\/font>/gi, "");
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l, i) => !(i === 0 && /^\s*\d+\s*$/.test(l)));
    const timeAt = lines.findIndex((l) => l.includes("-->"));
    if (timeAt < 0) continue; // ASS headers, comments, stray text
    const timing = lines[timeAt]
      .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, "$1.$2")
      .replace(/^(\d):/, "0$1:")
      .replace(/\.(\d{1,2})(?=[^0-9]|$)/g, (m, ms) => `.${ms.padEnd(3, "0")}`)
      .trim();
    const body = lines.slice(timeAt + 1).map(strip).join("\n").trim();
    cues.push(body ? `${timing}\n${body}` : timing);
  }
  if (!cues.length) throw new Error("that file is not an SRT or WebVTT subtitle");
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** Fetch a subtitle file and hand back decoded WebVTT — the shared download step. */
async function fetchVtt(url, { headers = {}, name = "" } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow" });
  } catch (err) {
    return { ok: false, message: `The subtitle file could not be fetched — ${err?.message || err}` };
  }
  if (!res.ok) return { ok: false, message: `The subtitle file could not be fetched (HTTP ${res.status}).` };
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    const entry = unwrap(buf, name);
    return {
      ok: true,
      vtt: toVtt(decode(entry.text)),
      name: String(entry.name || name || "subtitle").replace(/\.(srt|vtt|zip|gz|ass|ssa)$/i, ""),
    };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/* ------------------------------------------------------------------ OpenSubtitles */

const OS_BASE = process.env.NUVIO_OPENSUBTITLES_BASE || "https://api.opensubtitles.com/api/v1";
/** The consumer key, as OpenSubtitles spells the header. */
const osKeyHeader = (key) => ({ "api-key": key });
let osToken = { value: "", for: "" };

const osCall = (path, opts) => fetchJson(`${OS_BASE}${path}`, opts);

/**
 * A session token for the configured login, or `""`.
 *
 * Downloading is a signed-in action as far as OpenSubtitles is concerned; searching is
 * not. A missing login is therefore not an error — it is a search-only setup, and the
 * pane and the player both say so rather than failing at the last step.
 */
async function osSession(force = false) {
  const o = subtitleService("opensubtitles");
  if (!o.username || !o.password) return "";
  const who = `${o.username}:${o.key.slice(-4)}`;
  if (!force && osToken.value && osToken.for === who) return osToken.value;
  const { res, json, text } = await osCall("/login", {
    method: "POST",
    headers: osKeyHeader(o.key),
    body: { username: o.username, password: o.password },
  });
  const value = json?.token || json?.data?.token || "";
  if (!res.ok || !value) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "OpenSubtitles refused the username and password"
        : `OpenSubtitles login failed (HTTP ${res.status})${json?.message ? ` — ${json.message}` : text ? ` — ${text.slice(0, 120)}` : ""}`,
    );
  }
  osToken = { value, for: who };
  return value;
}
const osForget = () => {
  osToken = { value: "", for: "" };
};

/** One OpenSubtitles result, in the handful of fields every provider shares. */
function osShape(entry) {
  const a = entry?.attributes || {};
  const file = (a.files || [])[0] || {};
  if (!file.file_id) return null;
  return {
    // OpenSubtitles' `file_id` is a real numeric id its download endpoint takes, so it is
    // used directly as the result's id rather than being remembered.
    id: Number(file.file_id),
    provider: "opensubtitles",
    language: String(a.language || "").toLowerCase(),
    release: String(a.release || a.feature_details?.title || file.file_name || "Subtitle").trim(),
    downloads: Number(a.download_count ?? a.new_download_count ?? 0),
    rating: Number(a.ratings ?? 0),
    hearingImpaired: Boolean(a.hearing_impaired),
    automatic: Boolean(a.ai_translated || a.machine_translated),
  };
}

const opensubtitles = {
  name: "opensubtitles",
  label: "OpenSubtitles",
  async search({ imdb = "", type = "movie", season = "", episode = "", name = "", language = "", limit = 40 } = {}) {
    const o = subtitleService("opensubtitles");
    if (!o.ready) return notReady("opensubtitles");
    const lang = String(language || subtitleLanguage()).toLowerCase();
    const episodeSearch = type === "series" && Number(season) > 0 && Number(episode) > 0;
    const id = digits(imdb);
    const params = new URLSearchParams();
    if (id) {
      if (episodeSearch) {
        params.set("parent_imdb_id", id);
        params.set("season_number", String(Number(season)));
        params.set("episode_number", String(Number(episode)));
      } else {
        params.set("imdb_id", id);
      }
    } else if (String(name || "").trim()) {
      // No IMDb id (a live channel, or a title TMDB has none for): the title is the only
      // handle there is, and a query match is still better than an empty panel.
      params.set("query", String(name).trim());
    } else {
      return { results: [], message: "This stream has no IMDb id and no title to search OpenSubtitles with." };
    }
    if (episodeSearch) params.set("type", "episode");
    else if (!id) params.set("type", "all");
    params.set("languages", lang);
    if (lang === "en") params.set("hearing_impaired", "include");
    params.set("order_by", "download_count");
    params.set("order_direction", "desc");

    const cacheKey = `${this.name}:${params}`;
    const hit = searches.get(cacheKey);
    if (hit && hit.expires > now()) return { ...hit.value, cached: true };

    const { res, json } = await osCall(`/subtitles?${params}`, { headers: osKeyHeader(o.key) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, results: [], message: `OpenSubtitles refused the API key (HTTP ${res.status}). Check the key in Settings → Subtitles.` };
    }
    if (res.status === 429) {
      return { ok: false, results: [], message: "OpenSubtitles is rate-limiting this key — wait a moment and try again." };
    }
    if (!res.ok || !json) return { ok: false, results: [], message: `OpenSubtitles did not answer (HTTP ${res.status}).` };
    const results = (json.data || []).map(osShape).filter(Boolean).slice(0, limit);
    const value = { ok: true, results };
    searches.set(cacheKey, { value, expires: now() + SEARCH_TTL_MS });
    return value;
  },
  async download(fileId, { language = "", name = "" } = {}) {
    const o = subtitleService("opensubtitles");
    const id = Number(fileId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false, message: "That subtitle has no file id." };

    const auth = await osSession();
    const post = (bearer) =>
      osCall("/download", { method: "POST", headers: osKeyHeader(o.key), sign: bearer, body: { file_id: id, sub_format: "srt" } });

    let { res, json } = await post(auth);
    if ((res.status === 401 || res.status === 403) && auth) {
      // The token aged out. Minting a new one and retrying once is the whole point of
      // holding it rather than re-logging-in on every pick.
      osForget();
      const fresh = await osSession();
      if (fresh) ({ res, json } = await post(fresh));
    }
    if (!res.ok) {
      const message =
        (res.status === 401 || res.status === 403) && !o.canDownload
          ? "OpenSubtitles wants a signed-in account to download — add your username and password in Settings → Subtitles (searching still works without it)."
          : `OpenSubtitles refused the download (HTTP ${res.status})${json?.message ? ` — ${json.message}` : ""}.`;
      return { ok: false, message };
    }
    const link = json?.link;
    if (!link) return { ok: false, message: "OpenSubtitles returned no file for that subtitle." };
    const hinted = String(json.file_name || name || "subtitle");
    const got = await fetchVtt(link, { name: hinted });
    if (!got.ok) return got;
    return { ok: true, vtt: got.vtt, name: hinted.replace(/\.(srt|vtt|zip|gz)$/i, ""), language: String(language || "").toLowerCase() };
  },
};

/* -------------------------------------------------------------------------- SubDL */

const SUBDL_BASE = process.env.NUVIO_SUBDL_BASE || "https://api.subdl.com";
const SUBDL_DL = process.env.NUVIO_SUBDL_DL_BASE || "https://dl.subdl.com";
/** SubDL's download host, joined without a doubled slash. */
const dlJoin = (url) => `${SUBDL_DL}${String(url).startsWith("/") ? "" : "/"}${url}`;

const subdl = {
  name: "subdl",
  label: "SubDL",
  async search({ imdb = "", tmdb = "", type = "movie", season = "", episode = "", name = "", year = "", language = "", limit = 40 } = {}) {
    const key = subtitleService("subdl").key;
    if (!key) return notReady("subdl");
    const lang = String(language || subtitleLanguage()).toLowerCase();
    const params = new URLSearchParams();
    params.set("api_key", key);
    const id = digits(imdb);
    if (id) params.set("imdb_id", id);
    else if (String(tmdb || "").trim()) params.set("tmdb_id", String(tmdb).replace(/^tmdb:/, "").trim());
    else if (String(name || "").trim()) params.set("film_name", String(name).trim());
    else return { results: [], message: "SubDL needs an IMDb or TMDB id, or a title." };
    if (type === "series") {
      params.set("type", "tv");
      if (Number(season) > 0) params.set("season_number", String(Number(season)));
      if (Number(episode) > 0) params.set("episode_number", String(Number(episode)));
    } else {
      params.set("type", "movie");
    }
    if (Number(year) > 0) params.set("year", String(Number(year)));
    if (/^[a-z]{2}$/.test(lang)) params.set("languages", lang.toUpperCase());
    params.set("subs_per_page", "30");
    // `unpack=1` asks for the individual files inside each release, which is what makes
    // the language and the "hearing impaired" flag trustworthy — the pack url alone says
    // neither.
    params.set("unpack", "1");

    const cacheKey = `${this.name}:${params}`;
    const hit = searches.get(cacheKey);
    if (hit && hit.expires > now()) return { ...hit.value, cached: true };

    const { res, json, text } = await fetchJson(`${SUBDL_BASE}/api/v1/subtitles?${params}`);
    if (!res.ok) return { ok: false, results: [], message: `SubDL did not answer (HTTP ${res.status}).` };
    if (json?.status === false) return { ok: false, results: [], message: `SubDL refused the request — ${json?.error || "check the key in Settings → Subtitles"}.` };
    if (!json) return { ok: false, results: [], message: `SubDL did not answer with JSON${text ? ` — ${String(text).slice(0, 120)}` : ""}.` };

    const subs = Array.isArray(json.subtitles) ? json.subtitles : [];
    const results = [];
    for (const s of subs) {
      const pack = s?.url ? { url: dlJoin(s.url), format: "" } : null;
      const entries = Array.isArray(s?.unpack_files) && s.unpack_files.length ? s.unpack_files : pack ? [pack] : [];
      for (const f of entries) {
        if (!f?.url) continue;
        results.push({
          id: remember("subdl", { url: /^https?:/i.test(f.url) ? f.url : dlJoin(f.url), format: f.format || "" }),
          provider: "subdl",
          language: String(f.language || s.language || lang || "").toLowerCase(),
          release: String(f.release_name || s.release_name || f.name || s.name || "Subtitle").trim(),
          downloads: 0,
          rating: 0,
          hearingImpaired: f.hi === true || String(f.hi || "").toLowerCase() === "true",
          automatic: false,
        });
      }
    }
    const value = { ok: true, results: results.slice(0, limit) };
    searches.set(cacheKey, { value, expires: now() + SEARCH_TTL_MS });
    return value;
  },
  async download(ref) {
    if (!ref?.url) return { ok: false, message: "That SubDL result has no file to fetch." };
    return fetchVtt(ref.url, { name: ref.format ? `subtitle.${ref.format}` : "" });
  },
};

/* --------------------------------------------------------------------- SubSource */

const SS_BASE = process.env.NUVIO_SUBSOURCE_BASE || "https://api.subsource.net/api/v1";
/** SubSource keys its catalogue by language *name*; the app speaks two-letter codes. */
const SS_LANG = Object.fromEntries(SUBTITLE_LANGUAGES.map(([code, label]) => [code, label.toLowerCase()]));
const ssLang = (code) => SS_LANG[code] || code;

const subsource = {
  name: "subsource",
  label: "SubSource",
  async search({ imdb = "", type = "movie", season = "", name = "", language = "", limit = 40 } = {}) {
    const key = subtitleService("subsource").key;
    if (!key) return notReady("subsource");
    const lang = String(language || subtitleLanguage()).toLowerCase();
    const headers = { "x-api-key": key };

    // Step one resolves a title to SubSource's own movie id — its subtitle list is only
    // ever asked for by that id.
    const titleId = digits(imdb);
    const q = new URLSearchParams();
    if (titleId) {
      q.set("searchType", "imdb");
      q.set("imdb", `tt${titleId}`);
    } else if (String(name || "").trim()) {
      q.set("searchType", "text");
      q.set("q", String(name).trim());
      if (type === "series") q.set("type", "series");
      if (Number(season) > 0) q.set("season", String(Number(season)));
    } else {
      return { results: [], message: "SubSource needs an IMDb id or a title." };
    }
    const found = await fetchJson(`${SS_BASE}/movies/search?${q}`, { headers });
    if (found.res.status === 401 || found.res.status === 403) return { ok: false, results: [], message: "SubSource refused the API key — check it in Settings → Subtitles." };
    if (!found.res.ok) return { ok: false, results: [], message: `SubSource did not answer (HTTP ${found.res.status}).` };
    const movies = Array.isArray(found.json?.data) ? found.json.data : [];
    const wanted = Number(season);
    const sameImdb = (m) => titleId && String(m?.imdbId || "").replace(/[^0-9]/g, "") === titleId;
    const title =
      movies.find((m) => sameImdb(m) && (!wanted || !m.season || Number(m.season) === wanted)) ||
      movies.find(sameImdb) ||
      movies[0];
    if (!title?.movieId) return { ok: true, results: [], message: "SubSource has no matching title." };

    // Step two lists the subtitles for it.
    const params = new URLSearchParams({ movieId: String(title.movieId), limit: "100" });
    if (/^[a-z]{2}$/.test(lang)) params.set("language", ssLang(lang));
    const list = await fetchJson(`${SS_BASE}/subtitles?${params}`, { headers });
    if (!list.res.ok) return { ok: false, results: [], message: `SubSource did not answer (HTTP ${list.res.status}).` };
    const rows = Array.isArray(list.json?.data) ? list.json.data : [];
    const results = rows
      .map((r) => {
        const sid = r?.subtitleId ?? r?.id;
        if (sid === undefined || sid === null) return null;
        return {
          id: remember("subsource", { id: sid }),
          provider: "subsource",
          language: String(r.language || lang || "").toLowerCase(),
          release: String(r.releaseInfo || r.release || title.title || "Subtitle").trim(),
          downloads: Number(r.downloads ?? r.downloadCount ?? 0),
          rating: Number(r.rating ?? 0),
          hearingImpaired: r.hearingImpaired === true || String(r.hearingImpaired || "").toLowerCase() === "true",
          automatic: false,
        };
      })
      .filter(Boolean)
      .slice(0, limit);
    return { ok: true, results };
  },
  async download(ref) {
    const key = subtitleService("subsource").key;
    if (!ref?.id) return { ok: false, message: "That SubSource result has no id to fetch." };
    return fetchVtt(`${SS_BASE}/subtitles/${encodeURIComponent(ref.id)}/download`, { headers: { "x-api-key": key }, name: "subsource" });
  },
};

/* ------------------------------------------------------------------------- Wyzie */

const WYZIE_BASE = process.env.NUVIO_WYZIE_BASE || "https://sub.wyzie.io";

const wyzie = {
  name: "wyzie",
  label: "Wyzie",
  async search({ imdb = "", tmdb = "", type = "movie", season = "", episode = "", language = "", limit = 40 } = {}) {
    const key = subtitleService("wyzie").key;
    if (!key) return notReady("wyzie");
    const lang = String(language || subtitleLanguage()).toLowerCase();
    const id = digits(imdb) ? `tt${digits(imdb)}` : String(tmdb || "").replace(/^tmdb:/, "").trim();
    if (!id) return { results: [], message: "Wyzie needs an IMDb or TMDB id." };
    const params = new URLSearchParams();
    params.set("id", id);
    params.set("key", key);
    if (/^[a-z]{2}$/.test(lang)) params.set("language", lang);
    if (type === "series" && Number(season) > 0 && Number(episode) > 0) {
      params.set("season", String(Number(season)));
      params.set("episode", String(Number(episode)));
    }

    const { res, json } = await fetchJson(`${WYZIE_BASE}/search?${params}`);
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 || res.status === 429 ? " — check the key and your quota in Settings → Subtitles" : "";
      return { ok: false, results: [], message: `Wyzie did not answer (HTTP ${res.status}${hint}).` };
    }
    // The API answers with a bare array; the package it also ships wraps them in `data`.
    const items = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    if (!items.length && json && typeof json === "object" && !Array.isArray(json) && (json.error || json.message)) {
      return { ok: false, results: [], message: `Wyzie refused the request — ${json.error || json.message}.` };
    }
    const results = items
      .filter((x) => x && x.url)
      .map((x) => ({
        id: remember("wyzie", { url: x.url }),
        provider: "wyzie",
        language: String(x.language || lang || "").toLowerCase(),
        release: String(x.display || x.release || x.source || "Subtitle").trim(),
        downloads: 0,
        rating: 0,
        hearingImpaired: x.hi === true || String(x.hi || "").toLowerCase() === "true",
        automatic: false,
      }))
      .slice(0, limit);
    return { ok: true, results };
  },
  async download(ref) {
    if (!ref?.url) return { ok: false, message: "That Wyzie result has no file to fetch." };
    return fetchVtt(ref.url, { name: String(ref.url).split("/").pop() || "subtitle" });
  },
};

const PROVIDERS = { opensubtitles, subdl, subsource, wyzie };

/* -------------------------------------------------------------------- the flow */

/**
 * Search every enabled service and merge the results into one list.
 *
 * `imdb` is the *show's* IMDb id for an episode, which is why a series passes it with
 * `season`/`episode` instead of an episode id. `language` defaults to the one the app is
 * browsed in via Settings → Subtitles. A `provider` narrows the search to one service.
 */
export async function searchSubtitles({ imdb = "", tmdb = "", type = "movie", season = "", episode = "", name = "", year = "", language = "", limit = 40, provider = "" } = {}) {
  const enabled = subtitleServices();
  const wanted = provider ? enabled.filter((s) => s.name === provider) : enabled;
  if (!wanted.length) {
    return {
      ok: false,
      ready: enabled.length > 0,
      results: [],
      message: provider
        ? `${subtitleService(provider).label} is not set up — add its key in Settings → Subtitles.`
        : "No subtitle service is set up — add a key in Settings → Subtitles.",
    };
  }
  const lang = String(language || subtitleLanguage()).toLowerCase();
  const perService = Math.max(6, Math.ceil(limit / wanted.length));
  const settled = await Promise.all(
    wanted.map(async (svc) => {
      try {
        const out = await PROVIDERS[svc.name].search({ imdb, tmdb, type, season, episode, name, year, language: lang, limit: perService });
        return { name: svc.name, label: svc.label, ...out };
      } catch (err) {
        return { name: svc.name, label: svc.label, ok: false, results: [], message: `${svc.label} could not be searched — ${err?.message || err}` };
      }
    }),
  );
  const results = settled.flatMap((x) => x.results || []).slice(0, limit);
  const answered = settled.some((x) => x.ok !== false);
  const counts = settled.filter((x) => (x.results || []).length).map((x) => `${x.label} ${x.results.length}`);
  const message = results.length
    ? `${results.length} subtitle${results.length === 1 ? "" : "s"} — ${counts.join(", ")}.`
    : settled.map((x) => x.message).filter(Boolean).join(" ") || `No subtitles in ${lang} for this title.`;
  return {
    ok: answered,
    ready: true,
    language: lang,
    results,
    message,
    // Which service each verdict came from — the player shows a result's origin, and the
    // Settings check reads this rather than a bare count.
    services: settled.map((x) => ({ name: x.name, label: x.label, count: (x.results || []).length, error: x.ok === false ? x.message : "" })),
    cached: wanted.length === 1 ? Boolean(settled[0]?.cached) : false,
  };
}

/**
 * Download one subtitle and hand it back as WebVTT.
 *
 * `ref` is the result's token: a numeric file id for OpenSubtitles, or the remembered
 * token for every other service. The text is cached per service+token, so re-picking a
 * subtitle that already downloaded spends nothing.
 */
export async function downloadSubtitle(ref, { provider = "opensubtitles", language = "", name = "" } = {}) {
  const svc = PROVIDERS[provider];
  if (!svc) return { ok: false, message: `Unknown subtitle service "${provider}".` };
  const creds = subtitleService(provider);
  if (!creds.ready) return { ok: false, message: `No ${creds.label} key is set — add one in Settings → Subtitles.` };

  const cacheKey = `${provider}:${ref}`;
  const cached = files.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  const payload = provider === "opensubtitles" ? Number(ref) : recall(provider, ref);
  if (payload === undefined || payload === null) {
    return { ok: false, message: `That ${creds.label} subtitle is no longer available — search again.` };
  }
  let out;
  try {
    out = await svc.download(payload, { language, name });
  } catch (err) {
    return { ok: false, message: `${creds.label} could not download that subtitle — ${err?.message || err}` };
  }
  if (!out?.ok) return out;
  const value = {
    ok: true,
    provider,
    fileId: ref,
    language: String(language || out.language || "").toLowerCase(),
    name: out.name || "subtitle",
    vtt: out.vtt,
    // Its own path, so the player can attach it as a real `<track src>` and the browser
    // can seek inside it like any other same-origin resource.
    url: `/subtitles/${provider}/${ref}.vtt`,
  };
  files.set(cacheKey, value);
  return value;
}

/** The decoded WebVTT for one service+token, if it has already been downloaded. */
export const cachedSubtitle = (provider, ref) => files.get(`${provider}:${ref}`) || null;

/**
 * A live check for Settings → Subtitles.
 *
 * It runs the **same call the player runs** — a real search — rather than a dedicated
 * "ping": a key that passes a ping and fails the search it exists for has told the user
 * nothing. For OpenSubtitles with a login it also reports the account's remaining
 * downloads, which is the number that explains "the download stopped working" an hour later.
 */
export async function verifySubtitles(provider = "") {
  const name = provider || subtitleServices()[0]?.name || "";
  if (!name) return { ok: false, text: "No subtitle service is set up — add a key in Settings → Subtitles." };
  const svc = PROVIDERS[name];
  const creds = subtitleService(name);
  if (!creds.ready) return { ok: false, text: `No ${creds.label} key is set.` };

  if (name === "opensubtitles") {
    const probe = await opensubtitles.search({ imdb: "0133093", type: "movie", language: subtitleLanguage() });
    if (probe.ok === false) return { ok: false, text: probe.message };
    if (!creds.canDownload) {
      return { ok: true, text: `Key works — ${probe.results.length} subtitles found. Searching only: add a username and password to download.` };
    }
    try {
      const auth = await osSession(true);
      const { res, json } = await osCall("/infos/user", { headers: osKeyHeader(creds.key), sign: auth });
      if (!res.ok) return { ok: true, text: "Key and login work; the account limits could not be read." };
      const left = json?.data?.remaining_downloads;
      const who = json?.data?.user?.name ? ` as ${json.data.user.name}` : "";
      return { ok: true, text: `Key and login work${who}${Number.isFinite(Number(left)) ? ` — ${left} downloads left today` : ""}.` };
    } catch (err) {
      return { ok: false, text: String(err?.message || err) };
    }
  }

  // Every other service is key-only, so a search for a well-known film is the whole check.
  const probe = await svc.search({ imdb: "0133093", type: "movie", language: subtitleLanguage(), limit: 5 });
  if (probe.ok === false) return { ok: false, text: probe.message };
  return {
    ok: true,
    text: probe.results.length
      ? `${creds.label} key works — ${probe.results.length} subtitles found for a known film.`
      : `${creds.label} key works — the service answered (nothing matched the probe film).`,
  };
}

/** Which subtitle services would be searched right now — for diagnostics. */
export const subtitleProviderNames = () => subtitleServices().map((s) => s.name);
