/**
 * Live TV & Sports — the premium/DTH lineups, and the guide.
 *
 * Sources, in the order the request asked for them:
 *
 *   dth      the **premium, DTH and operator catalogue** (`dth.mjs`): the providers
 *            you subscribe to, read as a lineup and a guide. This is the default,
 *            and it is what the profile is for.
 *   m3u      your own playlist (an M3U/M3U8 URL or a local file) — what your own
 *            box or operator app exports
 *   xtream   an Xtream Codes login (host + username + password)
 *
 * It used to default to a **public free-TV directory** (iptv-org's own category
 * playlists). That is gone: a premium-television profile opening on free public
 * streams is the wrong app, and the directory's channels are not the ones anyone
 * subscribes to. What replaced it is not another public list — it is a catalogue of
 * real DTH/cable/premium operators, per country, read for its **lineup and guide**.
 *
 * Streams are never invented and never shipped: a premium channel's stream is
 * delivered to a subscriber's box. Export it from your own box as an M3U (or log in
 * to your Xtream panel) and the two meet on `tvg-id`: the guide is keyed on it, so
 * your playlist's channel lands exactly on the catalogue's lineup.
 *
 * The guide is XMLTV (`live.epg`, or a picked provider's own public feed). With one
 * set the Guide draws real programmes; without one it still draws the lineup and
 * says so, rather than inventing a schedule.
 *
 * Everything is cached on disk (git-ignored) and re-read on the app's refresh clock.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getSettings, activeRefreshMinutes } from "./settings.mjs";
import { DTH_PROVIDERS, countryTable, firstProviderEpg, orderCountries, pickedProviders, countryEpg, countryEpgs, countryName, everyCountry, premiumChannelsFor } from "./dth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.NUVIO_LIVE_FILE || path.join(__dirname, "live-cache.json");

/**
 * Codes the catalogue and the country table spell differently.
 *
 * The table says `GB` (`United Kingdom`); a playlist's own channel ids may say
 * `UK`. Picking either has to mean the same country, so the equivalence is spelled
 * out once here instead of being guessed at in two places.
 */
const COUNTRY_EQUIVALENTS = [new Set(["UK", "GB"])];

/** Every spelling a picked code stands for, including its own. */
export function countrySpellings(code) {
  const upper = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return [];
  const group = COUNTRY_EQUIVALENTS.find((set) => set.has(upper));
  return group ? [...group] : [upper];
}

/** Hard caps so a 200 000-channel playlist cannot take the server down. */
// Not a content limit: a bound on one read so a runaway feed cannot exhaust memory.
// A full world of lineups is comfortably inside it.
const MAX_CHANNELS = 200000;
// **No batch, no rotation.** These used to be caps on how much of the country table
// one read would touch — six guides for the schedule, sixteen lineups for the
// channels — and a cap on a read is how countries stayed unreachable. One read now
// covers **every** country; the concurrency in the merge below is what keeps a world
// of feeds from firing all at once, and it changes only the pace, not the coverage.
// **A country guide is big.** The old 24MB ceiling was below every real one — India
// unpacks to 68MB and the United States to 73MB — so `fetchText` threw "document too
// large" and the biggest lineups arrived empty. The cap is a guard against a runaway
// document, not a limit on content.
const MAX_BYTES = 192 * 1024 * 1024;
/**
 * How many bytes of guides **one load** will pull, and how many feeds a guide read
 * covers.
 *
 * Not a limit on coverage: a load reads what fits, keeps it in the cache, and the
 * next load (on the app's own refresh clock) skips what is already in hand and moves
 * on to the rest — so the lineup accumulates every country instead of re-reading the
 * same few, and no single request tries to hold the world's television in memory.
 */
const READ_BUDGET = 640 * 1024 * 1024;
const GUIDE_FEEDS_READ = 6;
/** How many countries' lineups one load reads at once. The guides are streamed, so
 *  this is pace, not memory: a country costs the channels it declares. */
const LINEUP_CONCURRENCY = 4;
/** The cache's own version, so a cache written by an older reader is not trusted. */
const READ_VERSION = 3;
/**
 * The **lineup's** own version, and the reason it exists.
 *
 * `READ_VERSION` guards which feeds are remembered as read; it says nothing about the
 * channels already in the cache. So a cache written when this profile still opened on
 * the public free-TV directory (iptv-org ids like `00sReplay.us@SD`, Pluto stream
 * URLs, **no `epgId`**) kept being served: the lineup stayed free TV with no Star,
 * Sony or Zee in it, and because none of those channels carried an `epgId` the
 * TiviMate grid could never join a channel to a programme — which is why it came out
 * as a ruler over empty rows. Bumping this discards a lineup written by another
 * reader and rebuilds it from the country guides, which declare real channels *and*
 * the id their schedule is filed under.
 */
// 5: the premium channels of a country are merged into its lineup (see
// `mergePremiumChannels`).
// 6: public free-to-air streams are married into the lineup (see
// `publicStreamIndex`) — an older cached lineup has no stream URLs in it and has to be
// rebuilt, not reused.
const LINEUP_VERSION = 7;
const FETCH_TIMEOUT = 25_000;

let cache = { at: 0, source: "", error: "", channels: [], groups: [], guide: null, countries: null, providers: null };

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (raw && Array.isArray(raw.channels)) cache = raw;
  } catch {
    /* no cache yet — the first request fills it */
  }
}

function writeCache() {
  try {
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  } catch {
    /* read-only fs — keep the in-memory copy */
  }
}

/**
 * A bounded text fetch: a playlist or an EPG is data, not a page to parse.
 *
 * `.gz` is decompressed here. **XMLTV feeds are published gzipped far more often
 * than not** — a full country's guide is tens of megabytes of XML — and a gzip body
 * read as text is binary noise, which is why a perfectly good EPG URL used to look
 * like an empty guide.
 */
async function fetchText(url, budget) {
  if (budget && budget.left <= 0) throw new Error("read budget spent for this load");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const isGzip = /\.gz(\?|#|$)/i.test(url) || /gzip/i.test(res.headers.get("content-encoding") || "");
    let text;
    if (isGzip && !/gzip/i.test(res.headers.get("content-encoding") || "")) {
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) throw new Error("document too large");
      text = zlib.gunzipSync(body).toString("utf8");
    } else {
      text = await res.text();
    }
    if (text.length > MAX_BYTES) throw new Error("document too large");
    if (budget) budget.left -= text.length;
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read an XMLTV document **as a stream**, one element at a time.
 *
 * A country's guide is 20-73MB of XML once unpacked, and reading several as whole
 * strings is what got the reader killed: three at once is a few hundred megabytes of
 * text sitting in memory before anything is even parsed. The document is never held
 * here — the gunzipped stream is scanned chunk by chunk and only the elements that are
 * wanted survive, so a feed costs what its channels and programmes weigh, not what its
 * file does. That is what lets the whole world's lineups be read a country at a time.
 *
 * `onBlock(kind, attrs, inner)` gets every complete `<channel>` / `<programme>`; a
 * chunk that ends mid-element keeps its tail for the next one.
 */
async function streamXMLTV(url, onBlock, budget) {
  if (budget && budget.left <= 0) throw new Error("read budget spent for this load");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT * 3);
  // **Did the document arrive whole?** A feed cut short by the read budget — or by a
  // stream that broke — must not be remembered as read, or the channels it still
  // held would never be read at all (that is how the United States' lineup came back
  // short while its feed was marked done).
  let complete = true;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { accept: "*/*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // A `.xml.gz` file is raw gzip (fetch will not unpack it); a body that arrived
    // with `content-encoding: gzip` has already been decoded by fetch.
    const decoded = /gzip/i.test(res.headers.get("content-encoding") || "");
    let stream = Readable.fromWeb(res.body);
    if (/\.gz(\?|#|$)/i.test(url) && !decoded) stream = stream.pipe(zlib.createGunzip());
    stream.setEncoding("utf8");
    let tail = "";
    try {
      for await (const chunk of stream) {
        if (budget) budget.left -= chunk.length;
        const text = tail + chunk;
        const re = /<(channel|programme)\b([^>]*)>([\s\S]*?)<\/\1>/g;
        let match;
        let end = 0;
        while ((match = re.exec(text))) {
          onBlock(match[1], match[2], match[3]);
          end = match.index + match[0].length;
        }
        tail = text.slice(end);
        // A malformed document must not grow the tail without bound.
        if (tail.length > 2_000_000) tail = tail.slice(-1_000_000);
        // The budget is spent: stop reading this feed. What has been parsed is kept,
        // and the feed is simply not marked as read, so the next load finishes it.
        if (budget && budget.left <= 0) {
          complete = false;
          break;
        }
      }
    } catch {
      // A stream that breaks mid-document still leaves everything read so far — and
      // the feed is left unread, so the rest is picked up next time.
      complete = false;
    }
  } finally {
    clearTimeout(timer);
  }
  return complete;
}

const titleCase = (s) =>
  String(s || "")
    .split(/[;\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/**
 * An M3U/M3U8 playlist → channels.
 *
 * `#EXTINF:-1 tvg-id="…" tvg-logo="…" group-title="Sports",Name` followed by the
 * stream URL. Attributes are optional and every playlist spells them a little
 * differently, so a channel is built from whatever is actually there — the name
 * is the last comma-separated part, and the trailing quality marker
 * ("(1080p)") is dropped from it.
 */
export function parseM3U(text, fallbackGroup = "") {
  const channels = [];
  const lines = String(text).split(/\r?\n/);
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attrs = {};
      for (const [, key, value] of line.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[key] = value;
      const comma = line.indexOf(",");
      const name = (comma === -1 ? "" : line.slice(comma + 1)).replace(/\s*\([^)]*\)\s*$/, "").trim();
      // The group-title is a `;`-separated list of categories, not a sentence.
      const groups = String(attrs["group-title"] || fallbackGroup)
        .split(";")
        .map((g) => g.trim())
        .filter(Boolean);
      pending = {
        id: attrs["tvg-id"] || "",
        name: name || attrs["tvg-id"] || "Channel",
        logo: attrs["tvg-logo"] || attrs.logo || "",
        groups: groups.length ? groups : ["General"],
        country: (String(attrs["tvg-id"] || "").match(/\.([a-zA-Z]{2})@/) || [])[1]?.toUpperCase() || "",
        url: "",
        epgId: attrs["tvg-id"] || "",
      };
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!pending) continue;
    pending.url = line;
    channels.push(pending);
    pending = null;
    if (channels.length >= MAX_CHANNELS) break;
  }
  return channels;
}

/** Xtream Codes: one login answers with the live streams and their metadata. */
async function xtreamChannels(live) {
  const host = String(live.host || "").replace(/\/$/, "");
  const base = `${host}/player_api.php?username=${encodeURIComponent(live.username || "")}&password=${encodeURIComponent(
    live.password || "",
  )}`;
  const data = JSON.parse(await fetchText(`${base}&action=get_live_streams`));
  if (!Array.isArray(data)) throw new Error("Xtream returned no streams");
  return data.slice(0, MAX_CHANNELS).map((c) => ({
    id: `xc-${c.stream_id}`,
    name: String(c.name || "Channel").trim(),
    logo: c.stream_icon || "",
    groups: [String(c.category_name || "General").trim()],
    country: "",
    url: `${host}/live/${encodeURIComponent(live.username || "")}/${encodeURIComponent(live.password || "")}/${c.stream_id}.m3u8`,
    epgId: c.epg_channel_id || "",
  }));
}

/** A channel name as the guide spells it: "101 Sky Sports Main Event" → "Sky Sports Main Event". */
const cleanChannelName = (value) =>
  String(value || "")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/^\s*\d{1,4}[\s.\-–|]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * An XMLTV document's own **lineup** — one channel per `<channel>` element.
 *
 * This is the half of XMLTV nobody reads: a guide file also declares every channel
 * it carries, with the id the programmes are keyed on, a display name and usually a
 * logo. For a DTH provider that declaration *is* the channel list — the operator's
 * own lineup — so the premium catalogue needs no separate channel data: its EPG
 * feed answers with the lineup and the schedule in one read.
 */
export function epgLineup(text, provider = {}) {
  const out = [];
  const seen = new Set();
  const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let match;
  while ((match = re.exec(String(text)))) {
    channelEntry(out, seen, match[1], match[2], provider);
    if (out.length >= MAX_CHANNELS) break;
  }
  return out;
}

/**
 * What a channel is, from its name.
 *
 * **A category, not a country.** The lineup's `<channel>` elements carry no genre,
 * so the group used to be the *feed's* name — one group per country, which is why the
 * Categories screen read "United States / India" and nothing else, and why picking a
 * country looked like it had replaced the categories with itself. A guide entry has a
 * name and nothing more to go on, and a channel's name says what it is far more often
 * than not, so this reads it: Sports, News, Movies, Kids, Music, Documentary,
 * Religious, Shopping, otherwise Entertainment. `country` still rides on the channel
 * for the country filter and the banner.
 */
const CATEGORY_RULES = [
  ["Sports", /\b(sport|sports|espn|nba|nfl|nhl|mlb|cricket|football|soccer|futbol|golf|tennis|f1|formula|racing|motogp|wwe|ufc|boxing|dazn|eurosport|beIN|sky sport|star sport|sony ten|willow)\b/i],
  ["News", /\b(news|cnn|abc news|cbsn|nbc news|sky news|al jazeera|ndtv|republic|zeenews|zee news|abp|times now|india today|dw|france 24|euronews|bloomberg|cnbc|weather)\b/i],
  ["Movies", /\b(movie|movies|cinema|film|hbo|starz|showtime|cinemax|mgm|epix|sky cinema|sony movie|max|goldmines|b4u|star gold|&pictures|&flix|tnt)\b/i],
  ["Kids", /\b(kids|kid|cartoon|toon|toons|nick|nickelodeon|disney|pogo|chutti|baby|junior|boomerang|cbeebies|babyfirst)\b/i],
  ["Music", /\b(music|mtv|vh1|hits|beats|trace|now 80s|kerrang|4music|clubbing)\b/i],
  ["Documentary", /\b(docu|documentary|discovery|nat geo|national geographic|history|animal planet|science|investigation|id |smithsonian|bbc earth)\b/i],
  ["Religious", /\b(religious|church|gospel|praise|worship|islam|quran|bhakti|devotional|darshan|god|faith|3abn|hope channel|ewtn|daystar|tbn|sanskriti|aastha)\b/i],
  ["Shopping", /\b(shopping|teleshop|shop|qvc|hsn|price|home order)\b/i],
  ["Adult", /\b(adult|xxx|playboy|hustler|penthouse|brazzers)\b/i],
];

export function categoryOf(name) {
  const text = String(name || "");
  for (const [label, re] of CATEGORY_RULES) if (re.test(text)) return label;
  return "Entertainment";
}

/** One `<channel>` element → the lineup entry the app draws (de-duplicated on its id). */
function channelEntry(out, seen, attrs, inner, provider) {
  const id = (String(attrs).match(/id="([^"]*)"/) || [])[1];
  if (!id || seen.has(id)) return;
  seen.add(id);
  const names = [...String(inner).matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map((m) => m[1]);
  const icon = (String(inner).match(/<icon[^>]*src="([^"]*)"/) || [])[1] || "";
  const name = cleanChannelName(names.find((n) => n && cleanChannelName(n)) || id);
  out.push({
    id,
    epgId: id,
    name: name || id,
    logo: icon,
    // **The channel's own category**, not the country that declared it.
    groups: [categoryOf(name)],
    country: provider.country || "",
    url: "",
  });
}

/**
 * One feed's lineup, **streamed** rather than read whole.
 *
 * A country guide is 20-73MB of XML; only its `<channel>` elements are wanted here,
 * and holding the document to find them is what made reading a few countries at once
 * impossible. The id seen is remembered across the read so a feed that repeats a
 * channel does not list it twice.
 */
async function feedLineup(url, provider, budget) {
  const out = [];
  const seen = new Set();
  const complete = await streamXMLTV(url, (kind, attrs, inner) => {
    if (kind === "channel" && out.length < MAX_CHANNELS) channelEntry(out, seen, attrs, inner, provider);
  }, budget);
  return { channels: out, complete };
}

/**
 * The premium/DTH catalogue, read as a lineup.
 *
 * One read per picked provider, its own EPG feed doing double duty: the `<channel>`
 * elements are the lineup, the `<programme>` elements are the guide. A provider with
 * no public feed still contributes its **name** as a category, so the Categories card
 * says what the catalogue holds even before an EPG URL is set for it.
 *
 * `live.m3u` is your own box's export. It is read once and matched on `tvg-id`, which
 * is what puts a stream URL on the catalogue's channel — the guide never has one.
 */
/** Run `worker` over `items`, at most `limit` at a time — a country's guide is a
 *  large fetch, and reading a hundred of them at once is a burst nobody wants. */
async function mapBounded(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * The countries a DTH lineup is read from.
 *
 * Picked operators decide it: their countries, or **every country in the table**
 * when none is picked, so the profile opens on DTH channels for all countries with
 * a guide rather than an error asking you to pick one first.
 */
function dthCountries(live, picked) {
  if (picked.length) return orderCountries(picked.map((prov) => prov.country));
  // **"All countries" means all of them.** The switch was ignored here — a profile
  // with it on and two countries ticked still read those two, so the setting looked
  // dead and the lineup stayed short of what the catalogue covers.
  if (live.allCountries) return orderCountries(everyCountry());
  const configured = (Array.isArray(live.countries) ? live.countries : []).flatMap((c) => countrySpellings(c));
  if (configured.length) return orderCountries(configured);
  // Every country, in **reading order** — the biggest markets first, so a load that
  // cannot cover the whole world still covers the countries a subscription list is
  // actually made of, and the rest follow on the next loads.
  return orderCountries(everyCountry());
}

/**
 * **The public free-to-air streams of a country.**
 *
 * `iptv-org` publishes, per country, a playlist of channels whose streams the
 * broadcasters publish themselves — a news or entertainment feed that is meant to be
 * watched. It is read here for the countries this profile is scoped to, indexed by
 * `tvg-id` and by name, and cached for twelve hours. Nothing premium is in it (a
 * subscription channel has no public URL and is never invented), which is why your own
 * playlist still takes priority and why some channels still have no stream at all.
 */
const PUBLIC_STREAM_TTL_MS = 12 * 3600_000;
const PUBLIC_STREAM_FALLBACK = ["US", "GB", "IN", "CA", "AU"];
let publicStreamCache = null;

async function publicStreamIndex(codes = []) {
  if (publicStreamCache && Date.now() - publicStreamCache.at < PUBLIC_STREAM_TTL_MS) return publicStreamCache;
  const wanted = (codes.length ? codes : PUBLIC_STREAM_FALLBACK).map((c) => String(c).toLowerCase()).slice(0, 16);
  const byId = new Map();
  const byName = new Map();
  await mapBounded(wanted, 4, async (code) => {
    try {
      const text = await fetchText(`https://iptv-org.github.io/iptv/countries/${code}.m3u`);
      for (const channel of parseM3U(text)) {
        if (!channel.url) continue;
        if (channel.epgId && !byId.has(channel.epgId)) byId.set(channel.epgId, channel);
        const key = String(channel.name || "").toLowerCase();
        if (key && !byName.has(key)) byName.set(key, channel);
      }
    } catch {
      // A country whose playlist is missing or unreachable simply has no public streams.
    }
  });
  publicStreamCache = { at: Date.now(), byId, byName };
  return publicStreamCache;
}

async function dthChannels(live) {
  const picked = pickedProviders(live.providers);
  const codes = dthCountries(live, picked);

  const streams = String(live.m3u || "").trim()
    ? parseM3U(/^https?:/i.test(live.m3u) ? await fetchText(live.m3u) : fs.readFileSync(live.m3u, "utf8"))
    : [];
  const byEpgId = new Map();
  for (const channel of streams) {
    if (channel.epgId && !byEpgId.has(channel.epgId)) byEpgId.set(channel.epgId, channel.url);
  }

  // Feeds, most specific first: a picked operator's own guide (its lineup is its
  // own), then the picked countries' guides, then the rest of the table — and
  // **every file a country publishes**, not just its first. A country's guides are
  // declarations of the channels in it, so they are a real lineup and not one name.
  const wanted = [];
  const enqueue = (url, provider) => {
    if (url && !wanted.some((w) => w.url === url)) wanted.push({ url, provider });
  };
  for (const prov of picked) if (prov.epg) enqueue(prov.epg, prov);
  for (const code of codes) {
    const owner = picked.find((prov) => prov.country === code) || { name: countryName(code), country: code };
    for (const url of countryEpgs(code)) enqueue(url, owner);
  }
  const manual = String(live.epg || "").trim();
  if (!wanted.length && manual) enqueue(manual, picked[0] || { name: "Channels", country: "" });

  // **Skip what an earlier load already read.** A country guide is 20-70MB of XML, so
  // re-reading the same feeds every load spends the whole budget on the countries
  // already known and never reaches the others. What they carried stays in the cache
  // (the merge below keeps it), so each load moves on to the feeds still missing —
  // which is how the lineup covers every country without one request holding it all.
  // The remembered reads are only trusted from **this** version of the reader: an
  // earlier build marked feeds as read after reading them only part of the way, and
  // honouring that map would keep those countries short for good.
  const alreadyRead = cache.readVersion === READ_VERSION ? cache.read || {} : {};
  const budget = { left: READ_BUDGET };
  const pending = wanted.filter((feed) => !alreadyRead[feed.url]);
  const results = await mapBounded(pending, LINEUP_CONCURRENCY, async (feed) => {
    try {
      const { channels, complete } = await feedLineup(feed.url, feed.provider, budget);
      return { feed, channels, complete };
    } catch {
      // A feed that failed this load is **not** marked as read: the next load tries it
      // again rather than dropping that country for good.
      return { feed, channels: [], complete: false };
    }
  });
  const read = { ...alreadyRead };
  // Only a feed that arrived **whole** is remembered as read. A cut-short one keeps
  // its channels and is read again next load, so nothing it held is lost.
  for (const r of results) if (r.complete && r.channels.length) read[r.feed.url] = Date.now();
  cache = { ...cache, read };

  // What earlier reads already found — a channel is kept once, however many loads
  // it took to reach it.
  const kept = new Map();
  for (const channel of cache.channels || []) if (channel?.id && !kept.has(channel.id)) kept.set(channel.id, channel);
  for (const r of results) for (const channel of r.channels) if (channel?.id && !kept.has(channel.id)) kept.set(channel.id, channel);
  let lineup = [...kept.values()];

  // Nothing readable (offline, or a country with no published guide): the catalogue's
  // own supplier names are the lineup, so the profile is never an empty screen.
  if (!lineup.length) {
    lineup = (picked.length ? picked : codes.map((code) => ({ id: code, name: countryName(code), country: code }))).map((prov) => ({
      id: prov.id,
      epgId: "",
      name: prov.name,
      logo: "",
      groups: [prov.name],
      country: prov.country,
      url: "",
    }));
  }
  // **A public free-to-air stream, so a channel plays with no playlist of your own.**
  // The catalogue carries lineups and guides and never a stream, and a premium channel's
  // stream belongs to a subscriber's box — so with nothing but the catalogue picked,
  // every channel had no URL and tapping one could only say "add a playlist". Channels
  // that *are* published for free (a broadcaster's own news or entertainment feed) do
  // have a public URL, so the lineup now marries those in: **your own playlist always
  // wins**, then a public match by `tvg-id`, then by name.
  let publicStream = null;
  try {
    publicStream = await publicStreamIndex(codes);
  } catch {
    /* offline, or a country with no published playlist: the lineup still stands */
  }
  return lineup.slice(0, MAX_CHANNELS).map((channel) => {
    const own = byEpgId.get(channel.epgId) || channel.url || "";
    const hit = own || !publicStream
      ? null
      : publicStream.byId.get(channel.epgId) || publicStream.byName.get(String(channel.name || "").toLowerCase());
    return {
      ...channel,
      url: own || hit?.url || "",
      // A public stream is free-to-air, and the card says so rather than letting a
      // channel with no URL look broken.
      publicStream: Boolean(!own && hit?.url),
      logo: channel.logo || hit?.logo || "",
    };
  });
}

/**
 * The country table and the provider catalogue, for the settings screen.
 *
 * Read from the shipped catalogue rather than a third-party directory API, so the
 * pickers work with no network at all.
 */
export function liveCountries() {
  // **Two countries are offered, not the whole table.** This profile draws the United
  // States and India, and a picker that offers seventy more countries only invites a
  // selection the lineup is not being built for. The table itself is untouched — the
  // operator catalogue still knows every code, and `countryName` still names them for
  // a channel that carries one.
  const offered = new Set(["US", "IN"]);
  return { countries: countryTable().filter((row) => offered.has(row.code)), providers: DTH_PROVIDERS };
}

/**
 * **The premium channels a country's lineup must contain.**
 *
 * A country guide declares most of a country's channels but tends to leave out the
 * operator channels you actually pay for — Star, Sony, Zee, Colors in India; HBO, FX,
 * FXX, Syfy in the US — which is why "there is no Star channel" was a fair complaint
 * against a lineup built only from those feeds. Each premium entry in `addon/dth.mjs`
 * is data with its country, its category and its `tvg-id`.
 *
 * Where the feed already declares the channel, the entry only **marks** it and keeps
 * the feed's own id — that id is what joins the channel to its schedule, and replacing
 * it would trade a working guide for a label. A channel the feed left out is added as
 * itself, so it is in the lineup, in its category and in search.
 */
function mergePremiumChannels(channels, codes) {
  const list = premiumChannelsFor(codes);
  if (!list.length) return channels;
  const byName = new Map(channels.map((c) => [String(c.name || "").toLowerCase(), c]));
  for (const ch of list) {
    const existing = byName.get(ch.name.toLowerCase());
    if (existing) {
      existing.premium = true;
      if (!(existing.groups || []).includes(ch.group)) existing.groups = [...(existing.groups || []), ch.group];
      continue;
    }
    const entry = { id: ch.tvgId, epgId: ch.tvgId, name: ch.name, logo: "", groups: [ch.group], country: ch.country, url: "", premium: true };
    channels.push(entry);
    byName.set(ch.name.toLowerCase(), entry);
  }
  return channels;
}

/** The groups a channel belongs to, as a flat unique list. */
const groupsOf = (channels) => {
  const counts = new Map();
  for (const c of channels) for (const g of c.groups || []) counts.set(g, (counts.get(g) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
};

/**
 * The channel list, read from the configured source.
 *
 * `force` re-reads it now (the Refresh now button); otherwise a cache younger
 * than the refresh interval is served as-is, which is what makes this update
 * itself on the same clock as every other row.
 */
export async function liveChannels({ force = false } = {}) {
  const live = getSettings().live || {};
  const mode = ["dth", "m3u", "xtream"].includes(live.mode) ? live.mode : "dth";
  const countries = (Array.isArray(live.countries) ? live.countries : []).flatMap((c) => countrySpellings(c)).sort();
  const providers = (Array.isArray(live.providers) ? live.providers : []).map(String).sort();
  // **The cache key has to carry every setting that decides the lineup**, or a switch
  // looks dead: "All countries" riding off while two countries stayed ticked left the
  // key unchanged, so the old lineup was served and the toggle did nothing.
  const source = `${mode}|${live.m3u || ""}|${live.host || ""}|${live.username || ""}|${providers.join(",")}|${countries.join(",")}|all:${live.allCountries ? 1 : 0}`;
  const minutes = Number(live.refreshMinutes) || activeRefreshMinutes();
  const lifetime = minutes > 0 ? minutes * 60_000 : 6 * 3600_000;
  readCache();
  // A lineup written by another reader is **not** a hit: see `LINEUP_VERSION`.
  //
  // **The `read` marks go with the channels.** They are marks belonging to the
  // discarded lineup, and keeping them made a rebuild read *nothing*: every feed this
  // country table needs was already "read", so the merge found no new channels and the
  // profile fell back to one placeholder per country.
  if (cache.lineupVersion !== LINEUP_VERSION) cache = { ...cache, channels: [], groups: [], read: {}, readVersion: 0 };
  if (!force && cache.channels?.length && cache.source === source && Date.now() - cache.at < lifetime) {
    return cache;
  }
  try {
    const channels =
      mode === "m3u"
        ? parseM3U(/^https?:/i.test(live.m3u || "") ? await fetchText(live.m3u) : fs.readFileSync(live.m3u, "utf8"))
        : mode === "xtream"
          ? await xtreamChannels(live)
          : await dthChannels(live);
    if (mode === "dth") mergePremiumChannels(channels, countries);
    if (!channels.length) throw new Error("no channels in that lineup");
    // **The lineup's own escapes, decoded once.** Every source is read above — an M3U
    // export, an Xtream login, the DTH directory, the XMLTV feeds' own channels — and
    // all of them can spell a name with the document's escaping in it. Done here,
    // where they meet, rather than in each reader: the rows, the Guide and the channel
    // page draw the same string and none of them should have to know about `&amp;`.
    for (const channel of channels) {
      const name = decodeEntities(channel.name).trim();
      if (name) channel.name = name;
      if (Array.isArray(channel.groups)) {
        channel.groups = [...new Set(channel.groups.map((g) => decodeEntities(g).trim()).filter(Boolean))];
      }
    }
    cache = {
      at: Date.now(),
      source,
      error: "",
      channels,
      groups: groupsOf(channels),
      guide: cache.guide || null,
      countries: cache.countries || null,
      providers: cache.providers || null,
      // Which guide files have already been read, so the next load starts where this
      // one stopped instead of re-reading the countries it already has. It must ride
      // on the cache — losing it would make every load read the same first feeds.
      read: cache.read || {},
      readVersion: READ_VERSION,
      lineupVersion: LINEUP_VERSION,
    };
    writeCache();
  } catch (err) {
    // A failed source keeps the last good list rather than emptying Live TV.
    cache = { ...cache, source, error: err.message, at: cache.channels?.length ? cache.at : Date.now() };
  }
  return cache;
}

/* ------------------------------------------------------------------- guide */

/** "20240101120000 +0000" → epoch ms (XMLTV's own timestamp format). */
export function xmltvTime(value) {
  const m = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s = "00", tz] = m;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!tz) return base;
  const sign = tz.startsWith("-") ? -1 : 1;
  const offset = (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) * 60_000;
  return base - sign * offset;
}

/**
 * An XMLTV document → programmes per channel.
 *
 * Deliberately a scan rather than a DOM parse: an XMLTV file is tens of
 * megabytes of one flat element, and this only needs the start, the stop, the
 * channel and the title — the four fields the grid draws.
 */
export function parseXMLTV(text, { from, to, limit = 4_000_000 } = {}) {
  const programmes = {};
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let match;
  let seen = 0;
  while ((match = re.exec(text)) && seen < limit) {
    seen += 1;
    programmeEntry(programmes, match[1], match[2], { from, to });
  }
  for (const list of Object.values(programmes)) list.sort((a, b) => a.start - b.start);
  return programmes;
}

/**
 * The XML/HTML escapes a feed writes, decoded.
 *
 * A directory and an XMLTV feed both write `&amp;` and `&quot;` — that is what the
 * document *means*, not what the channel is called — and every screen that drew the
 * name showed the document's own escaping in the middle of it (`Stingray Classic
 * R’n’B &amp; Soul`). Numeric escapes go first, so an escaped escape (`&amp;lt;`)
 * comes out as the literal text it is meant to be.
 */
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const fromCode = (code) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "");
export const decodeEntities = (value) =>
  String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCode(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => XML_ENTITIES[name]);

/** XMLTV text → the plain string it wraps: CDATA and inline tags removed, and the
 *  document's own escapes decoded, so a title reads `Cars & Stars TV`. */
const cleanXML = (s) =>
  decodeEntities(String(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "")).trim();

/**
 * One `<programme>` element → the grid's entry, or nothing when it falls outside the
 * window. The window check is what keeps a 30-hour guide down to the hours on screen.
 */
function programmeEntry(programmes, attrsText, inner, { from, to }) {
  const attrs = {};
  for (const [, key, value] of String(attrsText).matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[key] = value;
  const start = xmltvTime(attrs.start);
  const stop = xmltvTime(attrs.stop);
  if (!attrs.channel || !start) return;
  if (to && start > to) return;
  if (from && stop && stop < from) return;
  const title = (String(inner).match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || "";
  const desc = (String(inner).match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || "";
  (programmes[attrs.channel] ||= []).push({
    start,
    stop: stop || start + 1800_000,
    title: cleanXML(title) || "Programme",
    desc: cleanXML(desc).slice(0, 200),
  });
}

/**
 * One feed's programmes for a window, **streamed**.
 *
 * The text of a guide never exists as a string: its elements are handed over as they
 * arrive, and only the ones inside the window are kept — so reading the schedule for
 * a country costs the hours it covers, not the file it is published in.
 */
async function feedProgrammes(url, { from, to, limit = 4_000_000 }, budget) {
  const programmes = {};
  let seen = 0;
  await streamXMLTV(url, (kind, attrs, inner) => {
    if (kind !== "programme" || seen >= limit) return;
    seen += 1;
    programmeEntry(programmes, attrs, inner, { from, to });
  }, budget);
  for (const list of Object.values(programmes)) list.sort((a, b) => a.start - b.start);
  return programmes;
}

/**
 * The guide for the next `hours`, keyed by channel id.
 *
 * The URL is your own (`live.epg`) when you have set one, and otherwise the first
 * picked provider's **own** public feed — a DTH provider's guide is its lineup, so
 * picking Tata Play or Sky is enough to get a real schedule. With neither, the
 * answer is empty and the app draws the lineup with "no guide data" rather than a
 * fake schedule.
 */
export async function liveGuide({ hours = 6, force = false, countries = "" } = {}) {
  const live = getSettings().live || {};
  const wanted = String(countries || "")
    .split(",")
    .flatMap((c) => countrySpellings(c))
    .filter(Boolean);
  const all = await liveChannels({ force });
  // The Guide draws the lineup it is given, so scoping it to the picked countries
  // happens here rather than in the grid.
  const channels = wanted.length
    ? (all.channels || []).filter((c) => wanted.includes(String(c.country || "").toUpperCase()))
    : all.channels || [];
  // Your own EPG URL wins. Otherwise the schedule comes from the feeds the lineup
  // was read from: the picked operators' own guides, and — with none picked — the
  // **country guides themselves**, so "all countries" get a schedule too. Reading a
  // country guide is heavy, so **every** country's guide is merged rather than one
  // file being picked.
  const picked = live.mode === "m3u" || live.mode === "xtream" ? [] : pickedProviders(live.providers);
  const own = picked.filter((prov) => prov.epg).map((prov) => ({ url: prov.epg, key: prov.epg }));
  let feedList = own;
  if (!feedList.length && live.mode !== "m3u" && live.mode !== "xtream") {
    // **The feeds the grid is drawing.** A six-hour guide for the whole world is
    // gigabytes of XML — the world's guides cannot be held in one response — and
    // reading a fixed first few countries is how a country's channels sat there with
    // no schedule. The lineup is already in hand, so the guide follows **its own
    // weight**: the countries holding the most of it are read first, which are the
    // ones whose channels the grid actually shows. `GUIDE_FEEDS_READ` bounds one
    // load, and the picked countries' feeds are always in that set.
    const weight = new Map();
    for (const channel of channels) {
      const cc = String(channel.country || "").toUpperCase();
      if (cc) weight.set(cc, (weight.get(cc) || 0) + 1);
    }
    const ranked = [...weight.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([cc]) => cc);
    const codes = (ranked.length ? ranked : dthCountries(live, picked)).slice(0, GUIDE_FEEDS_READ);
    feedList = codes.flatMap((code) => countryEpgs(code)).map((url) => ({ url, key: url }));
  }
  const manual = String(live.epg || "").trim();
  if (manual) feedList = [{ url: manual, key: manual }];
  if (!feedList.length) return { start: Date.now(), end: Date.now() + hours * 3600_000, programmes: {}, channels, epg: false };
  const guideKey = feedList.map((f) => f.key).join("|");
  const minutes = Number(live.refreshMinutes) || activeRefreshMinutes();
  const lifetime = minutes > 0 ? minutes * 60_000 : 6 * 3600_000;
  readCache();
  if (!force && cache.guide?.at && cache.guide.url === guideKey && Date.now() - cache.guide.at < lifetime && cache.guide.programmes) {
    return { ...cache.guide.data, channels, epg: true };
  }
  try {
    const now = Date.now();
    // **The window is the hours on screen**, not two days of schedule: the grid draws
    // `hours` ahead, so a programme outside that is a programme nobody looks at — and
    // reading five times as much of six countries' guides is what makes this heavy.
    const window = { from: now - 3600_000, to: now + (Math.max(1, hours) + 1) * 3600_000 };
    const budget = { left: READ_BUDGET };
    const parts = await mapBounded(feedList, 3, async (feed) => {
      try {
        return await feedProgrammes(feed.url, window, budget);
      } catch {
        return {};
      }
    });
    const programmes = Object.assign({}, ...parts);
    const data = { start: now, end: now + hours * 3600_000, programmes };
    if (!Object.keys(programmes).length) throw new Error("that EPG answered with no programmes");
    cache = { ...cache, guide: { at: now, url: guideKey, data } };
    writeCache();
    return { ...data, channels, epg: true };
  } catch (err) {
    return { start: Date.now(), end: Date.now() + hours * 3600_000, programmes: {}, channels, epg: false, error: err.message };
  }
}

/** What the Live TV settings screen reports back about the source. */
export async function liveStatus() {
  const live = getSettings().live || {};
  const list = await liveChannels();
  return {
    mode: ["dth", "m3u", "xtream"].includes(live.mode) ? live.mode : "dth",
    hasEpg: Boolean(String(live.epg || "").trim()) || Boolean(firstProviderEpg(live.providers)),
    hasPassword: Boolean(live.password),
    providers: Array.isArray(live.providers) ? live.providers : [],
    providerNames: pickedProviders(live.providers).map((prov) => prov.name),
    channels: list.channels?.length || 0,
    groups: list.groups || [],
    updated: list.at || 0,
    error: list.error || "",
  };
}
