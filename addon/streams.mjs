/**
 * Streams — the playable sources for one title, read from the add-ons you added.
 *
 * This runs **on the server** for the same reason `/api/source` does: a Stremio
 * add-on's stream endpoint is a plain HTTP call (`/stream/<type>/<id>.json`) but the
 * browser cannot make it unless that host sends permissive CORS headers, which most
 * do not. Fetching here has no such restriction, and it is also the only place the
 * add-on list is actually available — the sources live in the server's settings, so
 * they exist for the addon, the desktop app and AutoCAT itself.
 *
 * Stremio keys a stream request by **IMDb id** (`tt0137523`), which a TMDB title
 * does not carry, so one is resolved from TMDB's `external_ids` first.
 *
 * Only add-ons that declare the `stream` resource are asked. An add-on that declares
 * no `resources` at all is asked too — the field is optional and plenty of working
 * add-ons omit it, and asking a catalog-only add-on costs one 404.
 */
import { get, toMeta } from "./tmdb.mjs";
import { getSettings, activeLanguage } from "./settings.mjs";
import { imdbId } from "./posters.mjs";
// **Nuvio providers and CloudStream repositories** — the two source kinds that are not
// add-ons. Both are read on the server and both answer a different question from an add-on:
// a Nuvio provider is asked with the **TMDB id** this app already holds (no IMDb lookup),
// and a CloudStream extension is almost always compiled for Android and is reported as such
// rather than pretending to work. See `nuvio.mjs` and `cloudstream.mjs`.
import { providerStreams } from "./nuvio.mjs";
import { extensionStreams } from "./cloudstream.mjs";

const STREAM_TTL_MS = 5 * 60 * 1000;
// **A failure is not worth five minutes.** "Nothing answered just now" — a host down,
// a request that took too long — used to be cached exactly like a real answer, so
// pressing Play again after fixing the add-on handed back the same empty result for
// the rest of the window. Successes keep the long TTL; a failed read is re-tried in
// seconds.
const FAIL_TTL_MS = 20 * 1000;
const cache = new Map();

/**
 * Remember one title's answer — except one that says **the settings have no
 * add-ons**, which is a fact about the settings rather than about the network. That
 * one may not outlive the settings it was read from, so it is never cached (and
 * saving settings clears the rest — see `clearStreamCache`).
 */
function remember(key, value) {
  if (value.reason === "no-sources") return value;
  cache.set(key, { at: Date.now(), ttl: value.ok ? STREAM_TTL_MS : FAIL_TTL_MS, value });
  return value;
}

/**
 * **Settings changed.** Every answer in here was read from the add-on list, so a
 * source added, removed or turned off has to reach the player at once — not up to
 * five minutes later, which is exactly "I pasted an add-on and nothing plays".
 */
export function clearStreamCache() {
  cache.clear();
}
// A guard against a runaway list, not a cap on content: every source you added is
// asked, however many there are (it used to stop at twelve).
const MAX_SOURCES = 100000;
// How long one add-on may take before it is written off. **Not a cap on content** —
// it is how long we wait. A real add-on scrapes several hosts per request: PenguPlay
// answers a *movie* in ~5.5s but a whole *series* search takes longer, and the old
// 15s deadline is exactly "PenguPlay never answers" — a working add-on reported as a
// failure. Waiting is free; a wrong "no streams" is not.
const TIMEOUT_MS = 60000;

/** Every source the user added, as stored. */
export const listSources = () => (Array.isArray(getSettings().sources) ? getSettings().sources : []);

/**
 * Why a AutoCAT plugin did not answer **over HTTP**: it is not that it is broken.
 *
 * A AutoCAT plugin declares **scrapers** — Javascript the app runs itself — and has no
 * `/stream/…` endpoint to call, so a 404 is the expected answer for that URL and
 * saying "HTTP 404" makes a working plugin look broken. Its scrapers are run here
 * instead, so this is only the note left behind when a source was added as an add-on
 * but is really a plugin. (Running those scrapers was removed along with AutoCAT plugins
 * as a whole.)
 */
function pluginNote(source, status) {
  const scrapers = Array.isArray(source.scrapers) ? source.scrapers.length : 0;
  if (scrapers) return `${scrapers} scrapers — run on the server, not at a stream URL`;
  // **A 5xx is the add-on's own host failing, not a bad request from here.** It is the
  // one case worth naming, because a bare "HTTP 502" in the Sources drawer reads like
  // this app broke — and the reader needs to know it is the add-on's side, not theirs.
  if (status >= 500) return `HTTP ${status} — the add-on's own server is failing`;
  return `HTTP ${status}`;
}

/**
 * **A 5xx from an add-on is usually transient.**
 *
 * A Cloudflare-fronted add-on answers `502` while its origin restarts and works again
 * on the very next request — and this is the one case where the user is looking at an
 * empty Sources list, so a single retry after a short pause is worth far more than it
 * costs. Only 5xx is retried: a 404 is an answer (an add-on with no `/stream` endpoint
 * means exactly that), and retrying it would only double every legitimate miss.
 */
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const ADDON_HEADERS = { accept: "application/json", "user-agent": "AutoCAT/1.0" };

async function addonFetch(url, ms, { retry = true } = {}) {
  const send = () => fetch(url, { headers: ADDON_HEADERS, signal: AbortSignal.timeout(ms) });
  const res = await send();
  if (res.ok || !retry || !TRANSIENT_STATUS.has(res.status)) return res;
  // Let the origin come back before asking again.
  await new Promise((r) => setTimeout(r, 700));
  return send();
}

/** Add-ons that can answer a stream request at their own `/stream/…` endpoint. */
const streamSources = (type) =>
  listSources()
    .filter((s) => s && s.url)
    // A **plugin** is not asked at a URL — its scrapers are run for it (see below).
    .filter((s) => s.type === "stremio" || s.kind === "addon")
    // **A turned-off Streams provider is out of the play list.** The toggle lives on
    // the source in Settings → Add-ons, so it is honoured here where the list is
    // built rather than only on the settings screen.
    .filter((s) => !(Array.isArray(s.disabled) ? s.disabled : []).includes("stream"))
    .filter((s) => {
      const resources = Array.isArray(s.resources) ? s.resources : [];
      // No declared resources → ask anyway (the field is optional). Declared but
      // without `stream` → this add-on serves catalogs, not video.
      return !resources.length || resources.includes("stream");
    })
    .slice(0, MAX_SOURCES);

// **AutoCAT plugins are gone.** Their scrapers used to be run on the server by a
// dedicated runner; the source type, the settings pane and that runner were all
// removed, so the only way a title plays here is a Stremio add-on.

/**
 * The trackers a Stremio stream names, as announce URLs.
 *
 * The spec lists them as `tracker:<url>` (and `dht:<node>` for a DHT bootstrap);
 * only the trackers belong in a magnet, and the prefix is dropped.
 */
const trackersOf = (s) =>
  (Array.isArray(s?.sources) ? s.sources : Array.isArray(s?.announce) ? s.announce : [])
    .map((entry) => String(entry || "").trim())
    .filter((entry) => /^tracker:/i.test(entry))
    .map((entry) => entry.replace(/^tracker:/i, ""))
    .filter(Boolean);

/**
 * A magnet URI for a torrent stream.
 *
 * Stremio publishes torrents as `infoHash` (plus `fileIdx` for the file to play and
 * `sources` for the trackers) rather than as a magnet, so one is built here — that is
 * what the player hands to the torrent engine. `dn` carries the title, so a client
 * that shows it has something readable instead of the hash, and a `fileIdx` becomes
 * the magnet's index so the right file of a season pack opens.
 */
function magnetOf(s, name) {
  const hash = String(s?.infoHash || "").trim();
  if (!/^[0-9a-f]{40}$|^[0-9a-z]{32}$/i.test(hash)) return "";
  const params = [`xt=urn:btih:${hash}`];
  const dn = String(s?.behaviorHints?.filename || name || "").trim();
  if (dn) params.push(`dn=${encodeURIComponent(dn)}`);
  if (Number.isFinite(s?.fileIdx)) params.push(`index=${Number(s.fileIdx)}`);
  for (const tracker of trackersOf(s)) params.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${params.join("&")}`;
}

/**
 * Stremio's stream objects → the app's own stream shape, labelled with the add-on.
 *
 * A Stremio stream carries a `url` (playable here), an `externalUrl` (a page to open
 * elsewhere — a host's own site, or the "support the project" line add-ons put first),
 * **or** an `infoHash` (a torrent, which is what most add-ons answer with). Keeping
 * those apart is what stops the player auto-playing a donation page, and reading the
 * torrent in is what makes a torrent add-on work at all — before this, every torrent
 * stream was dropped on the floor because it had no `url` to hand to a `<video>`.
 */
function readStreams(label, raw) {
  return raw
    .map((s) => {
      const direct = String(s.url || "").trim();
      const external = String(s.externalUrl || "").trim();
      // **A magnet handed to us as a `url` is still a magnet.** Some add-ons put the
      // magnet URI in `url` (with the trackers on it) and nothing in `infoHash`; read as
      // a direct link it went to a `<video>` element, and read as a torrent with no hash
      // the server answered "no info hash in this stream". Both are the same stream the
      // server can play — so a `magnet:` url is taken as the magnet it is.
      const magnetUrl = /^magnet:/i.test(direct) ? direct : "";
      const magnet = magnetUrl || (direct ? "" : magnetOf(s, s?.behaviorHints?.filename || s?.title || s?.name || ""));
      const infoHash = String(s.infoHash || "") || (magnetUrl ? String(magnetUrl.match(/xt=urn:btih:([a-z0-9]+)/i)?.[1] || "") : "");
      return {
        url: magnetUrl ? "" : direct || external,
        external: !direct && !magnet && Boolean(external),
        // A torrent: the player plays the magnet with its own engine, and this is
        // what makes it one. The `url` above may still be set (some add-ons hand a
        // torrent out with a proxy link as well), and a direct link always wins.
        torrent: Boolean(magnet),
        magnet,
        infoHash,
        fileIdx: Number.isFinite(s.fileIdx)
          ? Number(s.fileIdx)
          : (() => {
              const m = magnetUrl.match(/[&?]index=(\d+)/i);
              return m ? Number(m[1]) : null;
            })(),
        seeders: Number.isFinite(s.seeders) ? Number(s.seeders) : null,
        size: s.behaviorHints?.videoSize || s.size || null,
        // `name` is the quality/group line and `title` the detail line in the
        // Stremio spec; a stream that only carries one is shown by that one.
        name: String(s.name || ""),
        title: String(s.title || s.description || ""),
        quality: String(s.behaviorHints?.videoQuality || ""),
        source: label,
      };
    })
    .filter((s) => s.url || s.external || s.torrent);
}

/** `<base>/stream/<type>/<id>.json`, tolerating the URL shapes an add-on is added by. */
function streamUrl(sourceUrl, type, imdb) {
  const base = String(sourceUrl || "")
    .replace(/^stremio:\/\//i, "https://")
    .replace(/\/+$/, "")
    .replace(/\/(manifest|configure)\.json$/i, "");
  return `${base}/stream/${type}/${encodeURIComponent(imdb)}.json`;
}

/**
 * One title's streams, merged from every configured add-on.
 *
 * A source that fails is reported rather than swallowed: "no streams" and "your
 * add-on is down" are different answers, and the player has to say which one it is.
 */
export async function streamsFor(type, tmdbId, { name = "", force = false, season = "", episode = "" } = {}) {
  const media = type === "series" || type === "tv" || type === "show" ? "series" : "movie";
  // **An episode is asked for as an episode.** Stremio keys a series request on
  // `<imdb>:<season>:<episode>`, and an add-on that serves series uses those numbers
  // to pick the right episode's hosts — asking for the show alone is why an episode
  // came back with the show's links (or none).
  const wanted = media === "series" && season && episode ? `${season}:${episode}` : "";
  const key = `${media}:${tmdbId}${wanted ? `:${wanted}` : ""}`;
  if (!force) {
    const hit = cache.get(key);
    if (hit && hit.at + (hit.ttl || STREAM_TTL_MS) > Date.now()) return hit.value;
  }

  const sources = streamSources("stremio");
  const meta = { id: String(tmdbId).replace(/^tmdb:/, ""), type: media, name };
  // **The two provider kinds that do not need an IMDb id.** They are asked in parallel with
  // the add-ons below and merged, so a title with no IMDb id is still playable through a
  // Nuvio provider, and a title with no add-ons is still playable through one either.
  const providers = { tmdbId: meta.id, mediaType: media, season, episode };
  const direct = sources.length ? null : await Promise.all([
    providerStreams(providers).catch(() => ({ streams: [], sources: [] })),
    extensionStreams(providers).catch(() => ({ streams: [], sources: [] })),
  ]);
  const imdb = sources.length ? await imdbId(meta) : null;

  if (!sources.length) {
    const [nuvio, cloud] = direct || [{ streams: [], sources: [] }, { streams: [], sources: [] }];
    const streams = [...nuvio.streams, ...cloud.streams];
    const lines = [...nuvio.sources, ...cloud.sources];
    // Nothing to ask at all — no add-on, no provider — is the one case that is still
    // "no sources": the settings genuinely hold nothing that plays.
    if (!lines.length) return remember(key, { ok: false, reason: "no-sources", imdb, streams: [], sources: [] });
    return remember(key, { ok: streams.length > 0, imdb, count: streams.length, streams, sources: lines });
  }
  if (!imdb) {
    // Without an IMDb id a Stremio add-on cannot be asked for streams at all — but a Nuvio
    // provider can, so the providers are still asked and their answer is the answer.
    const [nuvio, cloud] = await Promise.all([
      providerStreams(providers).catch(() => ({ streams: [], sources: [] })),
      extensionStreams(providers).catch(() => ({ streams: [], sources: [] })),
    ]);
    const streams = [...nuvio.streams, ...cloud.streams];
    return remember(key, {
      ok: streams.length > 0,
      reason: streams.length ? "" : "no-imdb",
      imdb: null,
      count: streams.length,
      streams,
      sources: [...sources.map((s) => s.name || s.url), ...nuvio.sources, ...cloud.sources],
    });
  }

  const askAddon = async (source, idPart) => {
    const url = streamUrl(source.url, media, idPart);
    const res = await addonFetch(url, TIMEOUT_MS);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const data = await res.json();
    return readStreams(source.name || source.url, Array.isArray(data?.streams) ? data.streams : []);
  };

  const addonRuns = Promise.all(
    sources.map(async (source) => {
      const label = source.name || source.url;
      try {
        let streams = await askAddon(source, wanted ? `${imdb}:${wanted}` : imdb);
        // **An episode is tried as the show too.** Plenty of add-ons ignore the
        // `:season:episode` suffix and answer the whole series, so an episode came
        // back empty from an add-on that works fine for the film case. Asking again
        // with the bare IMDb id is the second chance, and the only cost is one more
        // request when the first found nothing.
        if (!streams.length && wanted) streams = await askAddon(source, imdb);
        return { label, ok: true, message: streams.length ? `${streams.length} streams` : "no streams", streams };
      } catch (err) {
        return {
          label,
          ok: false,
          message: err?.status ? pluginNote(source, err.status) : String(err?.message || err),
          streams: [],
        };
      }
    }),
  );
  // **The providers are asked while the add-ons are.** Different hosts, different protocols,
  // no shared state — so a title waits for the slowest of them, not for the sum.
  const [results, nuvio, cloud] = await Promise.all([
    addonRuns,
    providerStreams(providers).catch(() => ({ streams: [], sources: [] })),
    extensionStreams(providers).catch(() => ({ streams: [], sources: [] })),
  ]);

  const streams = [...results.flatMap((r) => r.streams), ...nuvio.streams, ...cloud.streams];
  return remember(key, {
    ok: streams.length > 0,
    imdb,
    count: streams.length,
    streams,
    // One line per source: which answered, with how many, and which did not. The
    // player's Sources drawer names these, so a pasted add-on is visible as itself
    // and a quiet one says why it was quiet — a Nuvio provider and a CloudStream
    // extension included, labelled by what they are.
    sources: [...results.map((r) => ({ name: r.label, ok: r.ok, message: r.message })), ...nuvio.sources, ...cloud.sources],
  });
}

const LIVE_CATALOG_TTL_MS = 30 * 60 * 1000;
const liveCatalogCache = new Map();

/**
 * How many of an add-on's live catalogues are read and searched.
 *
 * Twenty-one is a real number: CNCVerse Bridge publishes that many `tv` catalogues, and
 * the JioTV one that carries `Sony Max SD` is the **nineteenth** — so a cap of ten (and a
 * search over the first eight) reported a channel the add-on does carry as "no live
 * streams". The cap is only here so an add-on cannot make this unbounded work.
 */
const MAX_LIVE_CATALOGS = 48;
/** How many catalogue requests are in flight at once — a shelf of them is not a swarm. */
const LIVE_FETCH_CONCURRENCY = 6;

/**
 * How many of an add-on's live channels are merged into the Live TV lineup.
 *
 * A **budget, not a page count**: the lineup is one flat list, and CNCVerse Bridge
 * publishes 33,934 channels across its twenty-one catalogues — merging every one made the
 * lineup 38,000 long and the first read of it nine seconds. The catalogues are still read
 * in order and the budget stops the reading, so an add-on that fits (PenguPlay: 3,076)
 * is read whole. **The lookup is not capped**: a channel you open is searched across every
 * catalogue (`addonChannelIds`), which is what makes it play even when it sits in the
 * nineteenth.
 */
const MAX_ADDON_LINEUP_CHANNELS = 3000;

/**
 * How many of an add-on's catalogues may hold the channel being opened.
 *
 * A bridge carries one channel in several of its catalogues (CNCVerse has `Sony Max SD`
 * in its JTVWW, SKTech and JioTV live catalogues), and each serves a different upstream
 * URL — one of them is often dead. Asking only the first match is how a channel that
 * *does* play ends up opening a 404, so every match is asked, in catalogue order.
 */
const MAX_CHANNEL_IDS = 6;
/** How many streams from one add-on are handed to the player for a channel. */
const MAX_CHANNEL_STREAMS = 8;

/** An add-on's base URL, from however it was added. */
const addonBase = (url) =>
  String(url || "")
    .replace(/^stremio:\/\//i, "https://")
    .replace(/\/+$/, "")
    .replace(/\/(manifest|configure)\.json$/i, "");

const jsonFetch = async (url, ms = 20000) => {
  const res = await addonFetch(url, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/**
 * **How a Stremio app finds a live channel: through the add-on's own catalogue.**
 *
 * A live add-on publishes its channels as a *catalog* of `channel`/`tv` type, and the
 * id a stream request needs is that catalogue's own id — not the `tvg-id` this app's
 * lineup happens to use. Asking with our id alone is why an add-on that does carry
 * live TV answered nothing: the request was real, the id was not the add-on's.
 *
 * So each add-on's manifest is read once (cached 30 minutes), its live catalogues are
 * searched **by the channel's name** — `/catalog/<type>/<id>/search=<name>.json`, the
 * Stremio search form — and the match's own id is the one asked for a stream. Add-ons
 * that ignore `search` still answer their first page, which is indexed by name too.
 */
/**
 * A channel's name, reduced to what two catalogues can agree on.
 *
 * Add-ons decorate: `📺 SONY TEN 2`, `Sony Sports Ten 1 (1080p)`, and this app's own
 * lineup writes `Sony Max SD`. A guide's channel and an add-on's channel are the same
 * channel spelled differently, so emoji, brackets, punctuation and the quality marker
 * are dropped before the two are compared.
 */
const baseChannelName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(sd|hd|fhd|uhd|4k|1080p|720p|live|tv)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function addonLiveIndex(source) {
  const base = addonBase(source.url);
  const hit = liveCatalogCache.get(base);
  if (hit && Date.now() - hit.at < LIVE_CATALOG_TTL_MS) return hit;
  const index = { at: Date.now(), byName: new Map(), catalogs: [], channels: [] };
  liveCatalogCache.set(base, index);
  try {
    const manifest = await jsonFetch(`${base}/manifest.json`);
    const live = (manifest.catalogs || []).filter(
      (c) => c && c.id && /^(channel|tv|live)$/i.test(String(c.type || "")),
    );
    index.catalogs = live.map((c) => ({ type: String(c.type), id: String(c.id), name: String(c.name || "") }));
    // An add-on that declares no live catalogue can still answer a channel request — but
    // it can never be *found* by name, and the drawer should say which of the two "no
    // streams" this is.
    index.manifest = true;
    index.hasLiveCatalogs = index.catalogs.length > 0;
    // **Every live catalogue is read, in order, until the lineup's budget is met.**
    // PenguPlay publishes six: five are event lists (Live Now, Soccer, Cricket, Combat,
    // Upcoming) and the sixth — `pp-live-channels`, 2,000+ channels — is the one a channel
    // is actually in; reading only the first four is why a channel it carries was reported
    // as "no live streams". CNCVerse publishes twenty-one, and the budget is what keeps
    // its 34,000 channels from becoming the app's problem.
    const cats = index.catalogs.slice(0, MAX_LIVE_CATALOGS);
    for (let i = 0; i < cats.length && index.channels.length < MAX_ADDON_LINEUP_CHANNELS; i += LIVE_FETCH_CONCURRENCY) {
      // A batch is fetched whole — that is what makes six catalogues cost one round trip —
      // but only as much of it as the budget allows is merged.
      const pages = await Promise.all(
        cats.slice(i, i + LIVE_FETCH_CONCURRENCY).map(async (cat) => {
          try {
            const data = await jsonFetch(`${base}/catalog/${cat.type}/${encodeURIComponent(cat.id)}.json`);
            return (data?.metas || [])
              .filter((meta) => meta && meta.id)
              .map((meta) => ({
                id: String(meta.id),
                type: cat.type,
                name: String(meta.name || "").trim(),
                logo: meta.logo || meta.poster || "",
                group: cat.name || cat.id,
                source: source.name || source.url,
              }));
          } catch {
            /* an empty or refused catalogue is not a failure of the add-on */
            return [];
          }
        }),
      );
      // **The budget is spent in catalogue order** — so a 20,000-channel catalogue in the
      // middle of the shelf is not what Live TV ends up made of, and the small catalogues
      // ahead of it are not pushed out by it.
      for (const page of pages) {
        for (const entry of page) {
          if (index.channels.length >= MAX_ADDON_LINEUP_CHANNELS) break;
          index.channels.push(entry);
          const key = baseChannelName(entry.name);
          if (key && !index.byName.has(key)) index.byName.set(key, entry);
        }
      }
    }
    index.at = Date.now();
  } catch {
    // **A failure may not be cached.** The entry is written before the read so a
    // concurrent tap does not fetch the same manifest twice, and an unreachable add-on
    // would otherwise sit in here as "no live channels" for the full half hour after it
    // came back — the same mistake the stream cache had. Drop it and try again next tap.
    liveCatalogCache.delete(base);
  }
  return index;
}

/** **Every** id the add-on knows this channel by — one per catalogue that carries it. */
async function addonChannelIds(source, name) {
  const key = baseChannelName(name);
  if (!key) return [];
  const base = addonBase(source.url);
  const index = await addonLiveIndex(source);
  const out = [];
  const push = (entry) => {
    if (entry && entry.id && !out.some((o) => o.id === entry.id)) out.push(entry);
  };
  const indexed = index.byName.get(key);
  if (indexed) push(indexed);
  for (const c of index.channels || []) {
    if (out.length >= MAX_CHANNEL_IDS) break;
    if (baseChannelName(c.name) === key) push(c);
  }
  if (!out.length) {
    // Nothing exact: one loose match, the way this has always fallen back.
    const loose = (index.channels || []).find((c) => baseChannelName(c.name).includes(key));
    if (loose) push(loose);
  }
  // Not in the first page: ask the add-on's live catalogues the way a Stremio app
  // searches — the search suffix on each catalogue the add-on publishes. **All of them,
  // in small batches**: the channel may be in the nineteenth, and it may be in several
  // at once, each serving a different upstream URL.
  const cats = index.catalogs.slice(0, MAX_LIVE_CATALOGS);
  for (let i = 0; i < cats.length && out.length < MAX_CHANNEL_IDS; i += LIVE_FETCH_CONCURRENCY) {
    await Promise.all(
      cats.slice(i, i + LIVE_FETCH_CONCURRENCY).map(async (cat) => {
        try {
          const data = await jsonFetch(`${base}/catalog/${cat.type}/${encodeURIComponent(cat.id)}/search=${encodeURIComponent(name)}.json`);
          for (const meta of data?.metas || []) {
            if (!meta?.id) continue;
            const entry = { id: String(meta.id), type: cat.type, name: String(meta.name || "").trim(), logo: meta.logo || meta.poster || "", group: cat.name || cat.id, source: source.name || source.url };
            index.channels.push(entry);
            const metaKey = baseChannelName(entry.name);
            if (metaKey && !index.byName.has(metaKey)) index.byName.set(metaKey, entry);
            if (metaKey === key) push(entry);
          }
        } catch {
          /* this catalogue has no search: nothing to learn here */
        }
      }),
    );
  }
  return out.slice(0, MAX_CHANNEL_IDS);
}

/**
 * **The add-ons' own live channels, as channels of this app's Live TV.**
 *
 * This is what a Stremio app does that this one did not: an add-on's live catalogues are
 * live TV too, so their channels belong in the lineup beside the operator ones —
 * browsable, searchable and playable — instead of only being asked about a channel you
 * tapped somewhere else. Each entry carries the add-on and the id its stream must be
 * asked with (`/stream/<type>/<id>.json`), which is what `channelStreams` reads back.
 */
export async function liveAddonChannels() {
  const sources = streamSources("stremio");
  const out = [];
  const lines = [];
  await Promise.all(
    sources.map(async (source) => {
      try {
        const index = await addonLiveIndex(source);
        for (const entry of index.channels || []) {
          out.push({
            // A namespaced id: an add-on's own ids are not this lineup's ids, and the two
            // must not collide. Stable across loads, so a reopened channel is the same one.
            id: `addon:${entry.source}:${entry.id}`,
            epgId: "",
            name: entry.name.replace(/^[^\p{L}\p{N}]+/u, "").trim() || entry.name,
            logo: entry.logo,
            groups: [entry.group || "Add-ons", "Add-ons"],
            country: "",
            url: "",
            // How to play it: which add-on, and with which id and type.
            addonStream: { source: entry.source, type: entry.type, mediaId: entry.id },
          });
        }
        lines.push({
          name: source.name || source.url,
          ok: Boolean(index.manifest),
          message: !index.manifest
            ? "manifest could not be read"
            : index.catalogs.length
              ? `${(index.channels || []).length} live channels${
                  (index.channels || []).length >= MAX_ADDON_LINEUP_CHANNELS
                    ? ` — first ${MAX_ADDON_LINEUP_CHANNELS} in Live TV, the rest by search`
                    : ""
                }`
              : "no live catalogue in this add-on's manifest",
        });
      } catch (err) {
        lines.push({ name: source.name || source.url, ok: false, message: String(err?.message || err) });
      }
    }),
  );
  return { channels: out, sources: lines };
}

/**
 * **A Live TV channel's streams, from the add-ons you added.**
 *
 * A live channel has no IMDb id, so the request is the Stremio *channel* form —
 * `/stream/channel/<id>.json` — which is what an add-on that carries live TV answers.
 * The channel's own `tvg-id` is tried too, because that is the id a playlist and a
 * live add-on both know, and `tv` is tried last for add-ons that treat a channel as a
 * one-off title. Nothing is invented: an add-on with no live streams answers with
 * none, and the player says so.
 */
export async function channelStreams({ id, name = "", epgId = "", source: onlySource = "", type: onlyType = "", mediaId = "" }, { force = false } = {}) {
  const channelId = String(id || "").trim();
  // **A channel that came from an add-on.** Its own id and type are known (see
  // `liveAddonChannels`), so the stream is asked for exactly once, from that add-on —
  // no catalogue search, no guesses.
  const exact = mediaId ? { source: String(onlySource), type: String(onlyType || "tv"), id: String(mediaId) } : null;
  const key = `channel:${channelId}`;
  if (!force) {
    const hit = cache.get(key);
    if (hit && hit.at + (hit.ttl || STREAM_TTL_MS) > Date.now()) return hit.value;
  }
  const sources = streamSources("stremio");
  if (!sources.length) return remember(key, { ok: false, reason: "no-sources", streams: [], sources: [] });

  const ask = async (source, type, idPart) => {
    const res = await fetch(streamUrl(source.url, type, idPart), {
      headers: { accept: "application/json", "user-agent": "AutoCAT/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const data = await res.json();
    return readStreams(source.name || source.url, Array.isArray(data?.streams) ? data.streams : [])
      // **Only something that can actually play counts.** An add-on that does not carry
      // live TV still answers — PenguPlay replies to a channel request with its own
      // "donate" page — and counting that as a stream is how "the add-ons found nothing"
      // turned into "1 stream" that opened a web page. An `externalUrl` cannot play in
      // the player, and a support/donation link never should.
      //
      // **A torrent is not a live channel.** A channel's stream is a continuous URL,
      // so a peer-to-peer swarm cannot stand in for one — it is dropped here rather
      // than handed to a player that would sit at 0% forever.
      .filter((s) => !s.external && !s.torrent && !/donate|support|patreon|ko-?fi|buymeacoffee|paypal/i.test(s.url));
  };

  const ourIds = [...new Set([channelId, String(epgId || "").trim()].filter(Boolean))];
  const results = await Promise.all(
    sources.map(async (source) => {
      const label = source.name || source.url;
      if (exact) {
        // Only the add-on it came from, and only its own id.
        if (exact.source && label !== exact.source) return { label, ok: true, message: "not asked — this channel is from another add-on", streams: [] };
        try {
          const streams = await ask(source, exact.type, exact.id);
          return { label, ok: true, message: streams.length ? `${streams.length} streams` : "no streams", streams };
        } catch (err) {
          return { label, ok: false, message: err?.status ? pluginNote(source, err.status) : String(err?.message || err), streams: [] };
        }
      }
      try {
        let streams = [];
        // **The add-on's own channel ids first.** Its live catalogues are searched by the
        // channel's name (see `addonChannelIds`), and the ids it answers with are the ones
        // a Stremio app would ask for a stream — ours (`tvg-id` and the lineup id) are the
        // fallback for an add-on that keys its channels the way this app does.
        //
        // **Every id the add-on knows this channel by**, asked together: a bridge carries
        // one channel in several catalogues and each serves a different upstream URL, so
        // the first match alone can be the dead one. Only when the add-on knows none of
        // its own does this fall back to this app's ids (`tvg-id`, the lineup id).
        const owned = await addonChannelIds(source, name);
        const wanted = owned.length
          ? owned.map((o) => ({ type: o.type, id: o.id }))
          : [...new Set(["channel", "tv"])].flatMap((type) => ourIds.map((id) => ({ type, id })));
        let lastError = null;
        const answers = await Promise.all(
          wanted.map(async (want) => {
            try {
              return await ask(source, want.type, want.id);
            } catch (err) {
              lastError = lastError || err;
              return [];
            }
          }),
        );
        const seen = new Set();
        for (const s of answers.flat()) {
          if (!s?.url || seen.has(s.url)) continue;
          seen.add(s.url);
          streams.push(s);
          if (streams.length >= MAX_CHANNEL_STREAMS) break;
        }
        // An add-on that refused every request is a failed source, not an empty one.
        if (!streams.length && lastError) throw lastError;
        if (streams.length) return { label, ok: true, message: `${streams.length} streams`, streams };
        // **Two different "no".** An add-on with live catalogues that did not hold this
        // channel is a different answer from an add-on whose manifest declares no live
        // catalogue at all — the second one can never be searched by name, and saying so
        // is what turns a silent "no live streams" into something you can act on.
        const index = await addonLiveIndex(source);
        return {
          label,
          ok: true,
          message: index.manifest && !index.catalogs.length
            ? "no live catalogue in this add-on's manifest"
            : "no live streams",
          streams: [],
        };
      } catch (err) {
        return {
          label,
          ok: false,
          message: err?.status ? pluginNote(source, err.status) : String(err?.message || err),
          streams: [],
        };
      }
    }),
  );

  const streams = results.flatMap((r) => r.streams);
  return remember(key, {
    ok: streams.length > 0,
    channel: channelId,
    name,
    count: streams.length,
    streams,
    sources: results.map((r) => ({ name: r.label, ok: r.ok, message: r.message })),
  });
}

/** Used by the addon's own meta handler: the resolved IMDb id for a title. */
export async function imdbFor(type, id) {
  return imdbId({ id: String(id).replace(/^tmdb:/, ""), type: type === "series" ? "series" : "movie" });
}

/** A TMDB record with its IMDb id attached — the shape `toMeta` is happy with. */
export async function metaWithImdb(record, media) {
  const meta = toMeta(record, media);
  if (!meta) return null;
  const imdb = await imdbId(meta);
  if (imdb) meta.imdb = imdb;
  return meta;
}

export { activeLanguage };
