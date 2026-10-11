/**
 * Nuvio Collections — a Stremio/Nuvio catalog addon.
 *
 * Publishes one catalog row per catalog that lives inside each Nuvio card: a
 * card that names its catalogs (Discover → Latest, Newest, Trending,
 * Popular, Top Rated) yields one row per name; a card without names yet yields
 * a single collection-level row. Every row is backed live by TMDB, and only the
 * `catalog` resource is advertised — no search, no discover resource.
 *
 *   GET /manifest.json
 *   GET /catalog/{type}/{id}.json              (type = movie | series)
 *   GET /catalog/{type}/{id}/skip=100.json
 *   GET /addon-status.json                     (diagnostics)
 *
 * The addon is mounted by `serve.mjs`, so the same preview URL serves both the
 * cover gallery and the addon.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTINENTS,
  COUNTRIES,
  GLOBAL_OTT,
  collectionsFor,
  continentsWithContent,
  countryVocab,
  REMOVED_COUNTRY_CODES,
  keywordVocab,
  localServices,
  title as collectionTitle,
} from "../scripts/collections.mjs";
import { get, hasKey, toMeta, tmdbPath, setKey, resolveGenre, IMG } from "./tmdb.mjs";
import { askAI, askAbout, verifyAI, aiModels, aiProviderName, aiState } from "./ai.mjs";
import {
  STATES,
  STATE_LABEL,
  isState,
  list as watchlistList,
  counts as watchlistCounts,
  pin as watchlistPin,
  unpin as watchlistUnpin,
  metasFor as watchlistMetas,
  watchedKeys,
} from "./watchlist.mjs";
import {
  DEFAULT_ROW,
  items as customItems,
  list as customList,
  rows as customRows,
  clearRow as customClearRow,
  listRows as customRowList,
  addRow as customAddRow,
  renameRow as customRenameRow,
  deleteRow as customDeleteRow,
  moveRow as customMoveRow,
  MAX_ROWS as MAX_CUSTOM_ROWS,
  counts as customCounts,
  add as customAdd,
  remove as customRemove,
  metasFor as customMetas,
} from "./customrows.mjs";
import { catalogSpecs, activeRegion, catalogDefs, CATALOG_ID_PREFIX, findCatalog, primeTrendingSeeds, isOttSort } from "./catalogs.mjs";
import { activeCountry, activeContentSource, activeLanguage, getSettings, updateSettings, publicSettings, tmdbKey, providerKeys } from "./settings.mjs";
import { enrichRatings, ratingsState, titleRatings, verifyProvider } from "./providers.mjs";
import { applyPosters, postersEnabled, checkPosterService, imdbId } from "./posters.mjs";
import { applyContentSource, contentSourceActive, contentSourceStats } from "./tvdb.mjs";
import { inspectSource } from "./sources.mjs";
import { resolveMagnet, verifyDebrid, debridReady, DEBRID_SERVICES } from "./debrid.mjs";
import { searchSubtitles, downloadSubtitle, cachedSubtitle, verifySubtitles, SUBTITLE_LANGUAGES } from "./subtitles.mjs";
import { extractStreams } from "../scraper/index.js";
import { addPlugin, listPlugins, removePlugin } from "../scraper/plugins.js";
import { sessionDomains, clearSession } from "../scraper/sessions.js";
import { startManualVerification, finishManualVerification, cancelManualVerification, manualSessions, MANUAL_MESSAGE } from "../scraper/manual.js";
import { installDnsFetch } from "./net.mjs";
import { publicDns, updateDns, testDns, activeDnsServers, dnsScope } from "./dns.mjs";
import { handleProxy } from "./proxy.mjs";
import { guardState } from "./guards.mjs";
import { browserUnavailableReason } from "../scraper/tier3.js";
import { handleTorrentStream, prepareTorrent, torrentStatus, torrentState } from "./torrent.mjs";
import { authConfigured, authProviders, clearCookie, finish, forgetLocal, localAccount, readSession, sessionCookie, signInLocal, signOut, startUrl } from "./auth.mjs";
import { publicSites, addSite, updateSite, removeSite, detectSearchPattern, patternFromSample, addRepository, removeRepository, searchJob, startSearchOnPlay, listSites } from "./custom-sites.mjs";
import { getPrefs, updatePrefs } from "./user-prefs.mjs";

// **The DNS override is installed once, here.** Every request the server makes — metadata,
// add-ons, subtitles, debrid, the scraper, the stream proxy — goes through the global
// `fetch`, so wrapping it once is what makes the setting app-wide rather than per-call. A
// request made with no resolver configured is handed straight to the platform fetch.
installDnsFetch();
import { streamsFor, channelStreams, liveAddonChannels, clearStreamCache } from "./streams.mjs";
import { clearTmdbCache } from "./tmdb.mjs";
import { calendarMonth } from "./calendar.mjs";
import { liveChannels, liveGuide, liveStatus, liveCountries, countrySpellings } from "./live.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_FILE = path.join(__dirname, "watchlist.json");

export const ADDON_ID = "community.nuvio.collections";
export { CATALOG_ID_PREFIX };

const PAGE_SIZE = 40;

/**
 * How much one search window reads.
 *
 * Search and browse used to keep **twelve titles per row type**, then sixty, then
 * 120 — every one of those was a *cap*, and a cap is the bug: the server had already
 * fetched the titles and then threw them away, so a search offered exactly 120 of
 * something that had thousands. **Nothing is capped now.** A window is `SEARCH_PAGES`
 * TMDB pages per row type (TMDB answers twenty a page), and `Load more` reads the
 * next window and keeps going until TMDB has nothing left to ask for — so the count
 * under each group is the real number of results, and it grows as far as the row
 * does. The only limit left is TMDB's own (page 500 per query), which is not ours to
 * move.
 */
// A window is this many TMDB pages per row type. A window is not a limit on the
// catalog — the app keeps asking for the next one — it is how much is read in one
// request so a screen is not waiting on dozens of round-trips.
const SEARCH_PAGES = 20;

/**
 * Read up to `pages` pages of one TMDB list, stopping early at the last page.
 *
 * It answers with **how far it actually got**. A short page is the last page, and
 * the loop stops there — so a window can be three pages rather than six, and the
 * caller must continue from wherever the read really ended. Returning the count
 * (and whether the list is finished) is what makes "Load more" line up with TMDB
 * instead of skipping past the end of a short result set.
 */
async function readPages(path, params, pages = SEARCH_PAGES, start = 0) {
  const out = [];
  // `start` is how many pages have already been read, so page 2 of the screen is
  // TMDB's page 7 — that is what lets the results keep going instead of stopping
  // at a number the server picked.
  let read = 0;
  let ended = false;
  for (let page = start + 1; page <= start + pages; page += 1) {
    const data = await get(path, { ...params, page }).catch(() => ({ results: [] }));
    const list = data.results ?? [];
    read += 1;
    out.push(...list);
    // A short page is the last page — there is nothing after it to ask for.
    if (list.length < 20) {
      ended = true;
      break;
    }
  }
  return { items: out, pagesRead: read, ended, next: ended ? null : start + read };
}

let warnedNoKey = false;

/* --------------------------------------------------------------- settings */

/** Read the request body as JSON (used by POST /settings). */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/* ----------------------------------------------------------------- manifest */

/* ------------------------------------------------------------------ search */

const SEARCH_TYPES = ["movie", "series"];

/**
 * The search screen's filter vocabulary.
 *
 * Categories are genres, named per row type, because TMDB's movie and TV genre
 * sets are different: TV has no Romance, Horror or Thriller, and nothing called
 * Fantasy (it is "Sci-Fi & Fantasy"). A category a row type does not have is not
 * offered for that type, and choosing it while browsing excludes that row rather
 * than quietly dropping the filter and showing everything.
 */
const SEARCH_CATEGORIES = [
  //  label        movie genre        TV genre
  ["Romance", "Romance", null],
  ["Action", "Action", "Action & Adventure"],
  ["Fantasy", "Fantasy", "Sci-Fi & Fantasy"],
  ["Animation", "Animation", "Animation"],
  ["Suspense", "Thriller", null],
  ["Sci-Fi", "Science Fiction", "Sci-Fi & Fantasy"],
  ["Horror", "Horror", null],
  ["Comedy", "Comedy", "Comedy"],
  ["Crime", "Crime", "Crime"],
  ["Adventure", "Adventure", "Action & Adventure"],
  ["Thriller", "Thriller", null],
  ["Drama", "Drama", "Drama"],
  ["Mystery", "Mystery", "Mystery"],
  ["Family", "Family", "Family"],
  ["History", "History", "War & Politics"],
  ["War", "War", "War & Politics"],
  ["Western", "Western", "Western"],
  ["Documentary", "Documentary", "Documentary"],
  ["Reality", null, "Reality"],
  ["Kids", null, "Kids"],
];

/**
 * The panel filters by the *card lines*, not by an invented vocabulary: a
 * continent filter is the Continental card's own continents, the OTT filter is the
 * Global OTT card's own platforms, the Mood and Theme filters are the keyword rows
 * those two cards publish, and the Country filter is every country the Countries
 * card has a row for. One panel, the same names the cards use — which is what the
 * request meant by "a filter per card line".
 */
// **The panel offers what the cards publish** — the six continents with their thin
// countries dropped, and every country that clears the content floor. A choice that
// could only open an empty screen is not offered, which is the same rule the cards follow.
const SEARCH_CONTINENTS = [["all", "All continents"], ...continentsWithContent().map(([name]) => [name, name])];
const SEARCH_COUNTRIES = [["all", "All countries"], ...countryVocab()];
const SEARCH_PROVIDERS = [["all", "All services"], ...GLOBAL_OTT.map(([label, id]) => [String(id), label])];
const SEARCH_MOODS = [["all", "All moods"], ...keywordVocab("moods-and-vibes").map(([name, id]) => [String(id), name])];
const SEARCH_THEMES = [["all", "All themes"], ...keywordVocab("themes-and-tags").map(([name, id]) => [String(id), name])];

// Built from the same rows the filter offers, so a continent can only ever be searched
// with the countries the card itself publishes — and its thin ones are not in there.
const CONTINENT_CODES = new Map(continentsWithContent().map(([name, codes]) => [name, codes.join("|")]));
const COUNTRY_CODES = new Set(SEARCH_COUNTRIES.map(([code]) => code));
const PROVIDER_IDS = new Set(SEARCH_PROVIDERS.map(([id]) => id));
const MOOD_IDS = new Set(SEARCH_MOODS.map(([id]) => id));
const THEME_IDS = new Set(SEARCH_THEMES.map(([id]) => id));

/**
 * The period choices: **every year on its own**, newest first.
 *
 * It used to be the last eleven years and then two decade buckets, so "Time" could
 * not answer "2013" or "1998" — the two years you might actually be looking for were
 * folded into ranges. TMDB filters by a single year natively, so each one is a chip.
 *
 * A trailing "Before" went with it: one more pill at the far end of a long line, for
 * a range nobody asked for. The value itself is still accepted (`periodParam`,
 * `yearInPeriod`), so a saved link with `period=before` keeps working.
 */
function periodChoices() {
  const thisYear = new Date().getUTCFullYear();
  const years = [];
  for (let y = thisYear; y >= 1950; y -= 1) years.push([String(y), String(y)]);
  // No "Before" chip: "before 1950" sat at the far end of a line nobody scrolls to,
  // so the panel offers the years themselves. `period=before` is still understood
  // (`periodParam`, `yearInPeriod`) — an old link keeps working, it is just not offered.
  return [["all", "All Time Periods"], ...years];
}

const SEARCH_SORTS = [
  ["popularity", "Popularity"],
  ["recent", "Recent"],
  ["rating", "High Rating"],
];

const SEARCH_FILTERS = {
  types: [["", "All"], ["series", "TV Series"], ["movie", "Movie"]],
  continents: SEARCH_CONTINENTS,
  countries: SEARCH_COUNTRIES,
  providers: SEARCH_PROVIDERS,
  moods: SEARCH_MOODS,
  themes: SEARCH_THEMES,
  categories: {
    movie: SEARCH_CATEGORIES.filter(([, movie]) => movie).map(([label]) => label),
    series: SEARCH_CATEGORIES.filter(([, , tv]) => tv).map(([label]) => label),
  },
  periods: periodChoices(),
  sorts: SEARCH_SORTS,
};

/** The genre name behind a category label for one row type (null when it has none). */
const categoryGenre = (label, type) => {
  const row = SEARCH_CATEGORIES.find(([name]) => name === label);
  if (!row) return null;
  return (type === "movie" ? row[1] : row[2]) || null;
};

// An unknown value falls back to "all" rather than reaching TMDB as a bad filter —
// a hand-written URL can never empty the screen silently.
const pickOne = (value, allowed) => (allowed.has(value) ? value : "all");

/**
 * A period is "all", "before", a year, or a `YYYY-YYYY` range — validated by shape
 * rather than against the offered list, so a range a filter row does not happen to
 * offer (2011-2015 is offered as 2015-2011) still means what it says.
 */
const validPeriod = (value) => {
  const v = value || "all";
  return v === "all" || v === "before" || /^\d{4}$/.test(v) || /^\d{4}-\d{4}$/.test(v) ? v : "all";
};

const parseFilters = (params) => {
  const type = params.get("type");
  const category = params.get("category") || "all";
  return {
    type: type === "movie" || type === "series" ? type : "",
    continent: CONTINENT_CODES.has(params.get("continent")) ? params.get("continent") : "all",
    country: pickOne(params.get("country"), COUNTRY_CODES),
    provider: pickOne(params.get("provider"), PROVIDER_IDS),
    mood: pickOne(params.get("mood"), MOOD_IDS),
    theme: pickOne(params.get("theme"), THEME_IDS),
    category: category === "all" || SEARCH_CATEGORIES.some(([label]) => label === category) ? category : "all",
    period: validPeriod(params.get("period")),
    // The **original language** (`hi`, `en`, `pt`) — what a title page's *Original
    // language* row opens. TMDB's own field is a two-letter code, so a longer tag
    // (`hi-IN`) is read down to it rather than rejected.
    lang: validLang(params.get("lang")),
    sort: SEARCH_SORTS.some(([id]) => id === params.get("sort")) ? params.get("sort") : "popularity",
  };
};

/** A two-letter original-language code, or `all`. */
const validLang = (value) => {
  const code = String(value || "").trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : "all";
};

const FILTER_KEYS = ["continent", "country", "provider", "mood", "theme", "lang"];

const hasFilters = (f) =>
  Boolean(f.type) ||
  FILTER_KEYS.some((key) => f[key] !== "all") ||
  f.category !== "all" ||
  f.period !== "all" ||
  f.sort !== "popularity";

const filtersPayload = (f) => ({ ...f, active: hasFilters(f) });

/** The release year TMDB reports for a search result. */
const resultYear = (item, type) => {
  const date = type === "movie" ? item.release_date : item.first_air_date;
  const year = Number(String(date || "").slice(0, 4));
  return Number.isFinite(year) && year > 1800 ? year : null;
};

/** Does a year fall in the chosen period ("2026", "2015-2011", "before")? */
function inPeriod(year, period) {
  if (!period || period === "all") return true;
  if (period === "before") return year !== null && year <= 1999;
  if (/^\d{4}-\d{4}$/.test(period)) {
    const [a, b] = period.split("-").map(Number);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    return year !== null && year >= from && year <= to;
  }
  return year === Number(period);
}

/** The discover parameters behind a period choice. */
function periodParams(period, type) {
  const field = type === "movie" ? "primary_release_date" : "first_air_date";
  if (!period || period === "all") return {};
  if (/^\d{4}$/.test(period)) {
    // The dedicated year parameter is the only one that is exact for both types.
    return type === "movie" ? { primary_release_year: period } : { first_air_date_year: period };
  }
  if (/^\d{4}-\d{4}$/.test(period)) {
    const [a, b] = period.split("-").map(Number);
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    return { [`${field}.gte`]: `${from}-01-01`, [`${field}.lte`]: `${to}-12-31` };
  }
  return { [`${field}.lte`]: "1999-12-31" };
}

/** Sort choices, in TMDB's language. */
function sortParams(sort, type) {
  if (sort === "recent") return { sort_by: `${type === "movie" ? "primary_release_date" : "first_air_date"}.desc` };
  if (sort === "rating") return { sort_by: "vote_average.desc" };
  return { sort_by: "popularity.desc" };
}

/**
 * A title query, narrowed by whatever of the filters TMDB's search can honour.
 *
 * Search results carry their genre ids and their date, so the category and the
 * period can be applied to them; they carry **no origin country**, so the region
 * filter can only apply while browsing (the app says so on screen).
 */
async function searchTitles(query, f, { adult = false, start = 0 } = {}) {
  const types = f.type ? [f.type] : SEARCH_TYPES;
  const lists = await Promise.all(
    types.map(async (type) => {
      const { items: raw, next } = await readPages(`/search/${tmdbPath(type)}`, {
        query,
        ...(adult ? { include_adult: true } : {}),
      }, SEARCH_PAGES, start);
      let items = raw;
      const genreName = categoryGenre(f.category, type);
      if (f.category !== "all" && genreName) {
        const id = await resolveGenre(type, genreName);
        if (id) items = items.filter((it) => (it.genre_ids || []).includes(id));
      }
      if (f.period !== "all") items = items.filter((it) => inPeriod(resultYear(it, type), f.period));
      // TMDB's own `include_adult` is not enough: it is a hint, and some results
      // still carry `adult: true`. In SFW they are dropped here too.
      if (!adult) items = items.filter((it) => !it.adult);
      // Deduplicated on the way out: paging a search can repeat a title.
      const seen = new Set();
      return {
        metas: sortItems(items, type, f.sort)
          .filter((it) => (seen.has(it.id) ? false : seen.add(it.id)))
          .map((it) => toMeta(it, type))
          .filter(Boolean),
        next,
      };
    }),
  );
  return mergeWindows(lists);
}

/**
 * One window's titles, plus where the next window starts.
 *
 * Two row types are read together, and either can run out first: the cursor is the
 * **smallest** page still worth asking from, so neither row type is skipped over,
 * and it is null only when both are finished.
 */
function mergeWindows(lists) {
  const nexts = lists.map((l) => l.next).filter((n) => typeof n === "number");
  return {
    metas: lists.flatMap((l) => l.metas),
    next: nexts.length ? Math.min(...nexts) : null,
  };
}

/** Sort search results locally, since a search cannot be asked for an order. */
function sortItems(items, type, sort) {
  const year = (it) => resultYear(it, type) || 0;
  if (sort === "recent") return [...items].sort((a, b) => year(b) - year(a));
  if (sort === "rating") return [...items].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  return [...items].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

/**
 * Browsing with no text: TMDB discover, with every filter applied.
 *
 * This is the panel's real job — "Korean romance series, high rating" is a
 * discover query, not a search.
 */
async function browseTitles(f, { adult = false, start = 0 } = {}) {
  const types = f.type ? [f.type] : SEARCH_TYPES;
  const lists = await Promise.all(
    types.map(async (type) => {
      const genreName = categoryGenre(f.category, type);
      // The chosen category does not exist for this row type: an empty row is the
      // honest answer, not every title in it.
      if (f.category !== "all" && !genreName) return [];
      const params = {
        ...sortParams(f.sort, type),
        ...periodParams(f.period, type),
        // A rating sort needs a floor to mean anything: one 9.8 with two votes
        // would otherwise lead the row.
        "vote_count.gte": f.sort === "rating" ? 50 : 5,
      };
      // A continent is a set of origin countries; a single country is itself.
      const codes = f.continent !== "all" ? CONTINENT_CODES.get(f.continent) : f.country !== "all" ? f.country : "";
      if (codes) params.with_origin_country = codes;
      // The language a title was **made in** — not the language it is read in.
      if (f.lang !== "all") params.with_original_language = f.lang;
      // The OTT filter is a watch-provider filter, so it needs the region you are
      // browsing from as well — a service is only "available" somewhere.
      if (f.provider !== "all") {
        params.with_watch_providers = f.provider;
        params.watch_region = activeRegion();
        params.with_watch_monetization_types = "flatrate";
      }
      // Mood and Theme are keyword rows; both at once asks for titles that carry
      // both keywords, which is what choosing two does.
      const keywords = [f.mood, f.theme].filter((id) => id !== "all");
      if (keywords.length) params.with_keywords = keywords.join(",");
      if (genreName) {
        const id = await resolveGenre(type, genreName);
        if (!id) return [];
        params.with_genres = id;
      }
      if (adult) params.include_adult = true;
      const { items: raw, next } = await readPages(`/discover/${tmdbPath(type)}`, params, SEARCH_PAGES, start);
      let items = raw;
      if (!adult) items = items.filter((it) => !it.adult);
      const seen = new Set();
      return {
        metas: items
          .filter((it) => (seen.has(it.id) ? false : seen.add(it.id)))
          .map((it) => toMeta(it, type))
          .filter(Boolean),
        next,
      };
    }),
  );
  return mergeWindows(lists);
}

export function buildManifest(base) {
  const root = base.replace(/\/$/, "");
  const s = getSettings();
  return {
    id: ADDON_ID,
    version: "1.1.0",
    name: s.profile || "Nuvio Collections",
    description:
      "Curated Nuvio collection rows — on the board, spotlight, genres, decades, countries, runtimes, moods, themes, OTT charts and your watchlist. One cover per card, live titles from TMDB.",
    logo: `${root}/covers/movies/on-the-board.png`,
    background: `${root}/covers/movies/global-ott.png`,
    resources: ["catalog"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: catalogDefs().map((d) => ({
      type: d.type,
      id: d.id,
      name: d.name,
      extra: [{ name: "skip" }, { name: "genre", isRequired: false }],
    })),
    behaviorHints: { configurable: false },
  };
}

/* -------------------------------------------------------------- collections */

/**
 * Every card, with its cover and the catalogs it owns, per row. The desktop app
 * reads this to render the home screen — cards that own no catalogs render as
 * cover-only tiles.
 */
function collectionsPayload(root) {
  const byKey = new Map();
  for (const d of catalogDefs()) {
    if (!byKey.has(d.key)) byKey.set(d.key, []);
    byKey.get(d.key).push(d);
  }
  // The **Custom** card's label is a setting, so the card is named whatever the
  // user called it rather than the constant in the card set.
  const customLabel = String(getSettings().customLabel || "").trim();
  // The card set for the country in Settings — the regional OTT cards name that
  // country's services, so the cards and their rows are always read together.
  return collectionsFor(activeCountry()).map((c) => {
    const defs = byKey.get(c.key) || [];
    // A card can be named differently on each row — the Runtimes card is **Episodes**
    // on Shows — so the name travels with the row, not just with the card.
    const label = (type) => (c.key === "custom" && customLabel ? customLabel : collectionTitle(c, type === "movie" ? "movie" : "show"));
    const row = (type) => ({
      cover: `${root}/covers/${type === "movie" ? "movies" : "shows"}/${c.key}.png`,
      title: label(type),
      // `kind`/`state` let the app explain an empty row properly (a watchlist row
      // says how to fill it, a TMDB row says the catalog came back empty), and
      // `row` names the custom row so the app can add a title to it.
      // `divider` on a row draws a horizontal rule *before* it on the card page
      // (the Watchlist's Watching → Plan to Watch boundary).
      catalogs: c.key === "custom"
        // **The Custom card publishes the rows that exist.** Six slots are declared in the
        // card set; this keeps the managed ones, in the order Settings shows them, and
        // names each one what the user called it.
        ? customRowList()
            .map((r) => {
              const def = defs.find((d) => d.type === type && d.entry?.row === r.id);
              return def ? { id: def.id, name: r.name, kind: "custom", state: "", row: r.id, divider: false } : null;
            })
            .filter(Boolean)
        : defs
            .filter((d) => d.type === type)
            .map((d) => ({ id: d.id, name: d.name, kind: d.entry?.kind || "", state: d.entry?.state || "", row: d.entry?.row || "", divider: Boolean(d.entry?.divider) })),
    });
    // `divider` marks the card that is preceded by a vertical rule in the app;
    // `hidden` marks a card the grid does not draw (the banner's own source) — and
    // the **For You** card hides itself while the watchlist is empty, because a
    // "more like what you watch" card on an empty watchlist is a lie.
    // **The For You card is part of the grid even with an empty watchlist.** It used
    // to hide itself until something was pinned, which meant you never learned it was
    // there; with nothing pinned its row falls back to what is trending (the
    // `recommend` case in `catalogs.mjs`), so the card opens on titles either way.
    const hidden = Boolean(c.hidden);
    // `spotlight` tells the app to draw this card as a **window on one still at a
    // time** — the Upcoming card: one picture that changes every ten seconds like the
    // hero banner's, and no button in the frame, because the card is a glance rather
    // than a catalog to walk through.
    const spotlight = Boolean(c.spotlight);
    return { key: c.key, title: label("movie"), divider: Boolean(c.divider), hidden, spotlight, movie: row("movie"), series: row("series") };
  });
}

/* --------------------------------------------------------- the title page */

/** One credit / studio / network row on the title page. */
const personCard = (p, role) => ({
  id: `person:${p.id}`,
  tmdbId: p.id,
  name: p.name || "",
  role: role || "",
  poster: p.profile_path ? `${IMG}/w185${p.profile_path}` : "",
});

const logoCard = (kind, p) => ({
  id: `${kind}:${p.id}`,
  tmdbId: p.id,
  kind,
  name: p.name || "",
  logo: p.logo_path ? `${IMG}/w185${p.logo_path}` : "",
});

/**
 * Everything the title page draws, in one payload.
 *
 * Each list on the page carries the id of the endpoint that opens it, so the page
 * never has to know how a `with_companies` discover query is built — it asks for
 * `/list/company/1.json` and gets that studio's films. That is what makes every
 * name on the page a way into its own catalog rather than a label.
 */
async function titlePayload(type, id, adult = false) {
  const media = type === "series" ? "series" : "movie";
  const endpoint = media === "series" ? "tv" : "movie";
  const detail = await get(`/${endpoint}/${id}`, {
    language: activeLanguage(),
    append_to_response: "credits,recommendations,similar,external_ids,content_ratings,release_dates,videos,production_companies",
  });

  const meta = toMeta(detail, media) || { id: `tmdb:${id}`, type: media, name: detail.name || detail.title || "Untitled" };
  const imdb = detail.external_ids?.imdb_id || "";
  if (imdb) meta.imdb = imdb;

  // Age rating: shows carry it in `content_ratings`, films in `release_dates`.
  const cert =
    media === "series"
      ? (detail.content_ratings?.results || []).find((r) => r.iso_3166_1 === "US")?.rating || ""
      : ((detail.release_dates?.results || []).find((r) => r.iso_3166_1 === "US")?.release_dates || [])
          .map((d) => d.certification)
          .find(Boolean) || "";

  const crew = detail.credits?.crew || [];
  const byJob = (...jobs) => dedupe(crew.filter((c) => c.id && jobs.includes(c.job))).map((c) => personCard(c, c.job));

  // **Trailers.** TMDB keeps a title's videos; the ones worth opening are its
  // trailers and teasers, newest first, YouTube only (that is where they play).
  const trailers = (detail.videos?.results || [])
    .filter((v) => v.site === "YouTube" && v.key && /trailer|teaser|clip/i.test(v.type || ""))
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")))
    .map((v) => ({ name: v.name || v.type || "Trailer", key: v.key, type: v.type || "Trailer", url: `https://www.youtube.com/watch?v=${v.key}` }));

  // **Ratings, from many services.** TMDB's own number always comes first; the
  // rest are the sources MDBList aggregates when its key is set.
  const tmdbScore = typeof detail.vote_average === "number" && detail.vote_average > 0 ? detail.vote_average.toFixed(1) : "";
  const ratings = [
    ...(tmdbScore ? [{ source: "tmdb", label: "TMDB", value: tmdbScore }] : []),
    ...(await titleRatings(meta).catch(() => [])),
  ];
  // **Why the row holds only what it holds.** A chosen service with no key, or one
  // over its daily limit, used to leave a row that quietly held TMDB alone; the page
  // says which it is now.
  const rState = ratingsState();
  const ratingsNote = !rState.available && rState.text ? rState.text : "";

  // Where the title is from, and in what language it was made.
  const originCountry = (detail.production_countries || []).map((c) => c.name).filter(Boolean).join(", ") || (detail.origin_country || []).join(", ");

  // **More like this**: TMDB's two answers to "what else", recommendations first
  // because they are the closer match, de-duplicated and never the title itself.
  const more = stripAdult(
    dedupe([...(detail.recommendations?.results || []), ...(detail.similar?.results || [])])
      .filter((r) => String(r.id) !== String(id))
      .map((r) => toMeta(r, media))
      .filter(Boolean),
    adult,
  );
  // **"More like this" gets the same artwork as every other row.** It used to be the
  // one row on the page that never went through the poster service (and the content
  // source), so it wore plain TMDB artwork next to rows wearing BetterPosters.
  try {
    await applyPosters(more);
    await applyContentSource(more);
  } catch {
    /* artwork is an extra — the row itself still stands */
  }

  return {
    ok: true,
    meta,
    imdb,
    certification: cert,
    runtime: detail.runtime || (detail.episode_run_time || [])[0] || 0,
    seasonsCount: detail.number_of_seasons || 0,
    episodesCount: detail.number_of_episodes || 0,
    // Genres carry their id: each one is a way into that genre's own catalog.
    genres: (detail.genres || []).map((g) => ({ id: g.id, name: g.name })),
    status: detail.status || "",
    releaseDate: detail.release_date || detail.first_air_date || "",
    originalLanguage: detail.original_language || "",
    originCountry,
    // The country **codes** behind the names, so Origin country on the page is a way
    // into that country's own list rather than a label.
    originCountryCodes: Array.isArray(detail.origin_country) ? detail.origin_country : [],
    trailers,
    ratings,
    ratingsNote,
    tagline: detail.tagline || "",
    creators: (detail.created_by || []).map((c) => personCard(c, "Creator")),
    directors: byJob("Director"),
    writers: byJob("Writer", "Screenplay", "Story"),
    cast: (detail.credits?.cast || []).map((c) => personCard(c, c.character || "")),
    companies: (detail.production_companies || []).map((c) => logoCard("company", c)),
    networks: (detail.networks || []).map((n) => logoCard("network", n)),
    collection: detail.belongs_to_collection
      ? { id: `collection:${detail.belongs_to_collection.id}`, tmdbId: detail.belongs_to_collection.id, name: detail.belongs_to_collection.name }
      : null,
    seasons:
      media === "series"
        ? (detail.seasons || [])
            .filter((s) => s.season_number > 0)
            .map((s) => ({
              number: s.season_number,
              name: s.name || `Season ${s.season_number}`,
              episodes: s.episode_count || 0,
              year: String(s.air_date || "").slice(0, 4),
              poster: s.poster_path ? `${IMG}/w342${s.poster_path}` : "",
            }))
        : [],
    more,
  };
}

/**
 * One name's own catalog.
 *
 *   person/<id>          their credits, in the row type you are on
 *   company/<id>         that studio's titles
 *   network/<id>         that network's titles
 *   collection/<id>      the franchise's parts, in release order
 *   season/<show>/<n>    that season's episodes
 */
async function listPayload(kind, first, second, media, adult, page = 1) {
  const language = activeLanguage();
  const base = { language, ...(adult ? { include_adult: true } : {}) };
  const finish = async (metas, more = false) => {
    const list = stripAdult(metas.filter(Boolean), adult);
    try {
      await applyPosters(list);
      await applyContentSource(list);
      await enrichRatings(list);
    } catch {
      /* artwork and ratings are extras — the list itself still stands */
    }
    return { metas: list, more };
  };

  if (kind === "person") {
    const data = await get(`/person/${first}/combined_credits`, base);
    const wanted = [...(data.cast || []), ...(data.crew || [])].filter((c) =>
      media === "movie" ? c.media_type === "movie" : c.media_type === "tv",
    );
    return finish(dedupe(wanted).map((c) => toMeta(c, media)));
  }

  if (kind === "collection") {
    const data = await get(`/collection/${first}`, { language });
    const parts = [...(data.parts || [])].sort((a, b) => String(a.release_date || "").localeCompare(String(b.release_date || "")));
    return finish(parts.map((p) => toMeta(p, "movie")));
  }

  if (kind === "season") {
    const data = await get(`/tv/${first}/season/${second || 1}`, { language });
    // An episode is not a catalog title — it is part of the show, so every card
    // opens the show it belongs to.
    return { metas: (data.episodes || []).map((e) => ({
      id: `tmdb:${first}`,
      type: "series",
      name: `${e.episode_number}. ${e.name || ""}`.trim(),
      poster: e.still_path ? `${IMG}/w300${e.still_path}` : "",
      releaseInfo: String(e.air_date || "").slice(0, 4),
      imdbRating: typeof e.vote_average === "number" && e.vote_average > 0 ? e.vote_average.toFixed(1) : "",
      description: e.overview || "",
      // **What an episode list needs to be a list**: the number it is, the season it
      // belongs to, when it aired and how long it runs. A wall of stills with a
      // heading per card is a catalog; this is the shape the episode screen draws.
      episode: e.episode_number || 0,
      season: Number(second) || 1,
      airDate: e.air_date || "",
      runtime: e.runtime || 0,
    })), more: false };
  }

  // **A studio, a network, a genre or a keyword: a paged discover query.** These are
  // the lists that looked capped: TMDB answers twenty titles per page and the route
  // only ever asked for the first, so a network with hundreds of shows showed twenty
  // and stopped. `page` is the caller's own cursor, and `more` says whether TMDB has
  // another one — the client's *Load more* follows it.
  const SCOPED = { company: "with_companies", network: "with_networks", genre: "with_genres", keyword: "with_keywords", country: "with_origin_country" };
  const scoped = { [SCOPED[kind] || "with_companies"]: first };
  const wanted = Math.max(1, Number(page) || 1);
  const data = await get(`/discover/${media === "series" ? "tv" : "movie"}`, {
    ...base,
    ...scoped,
    sort_by: "popularity.desc",
    "vote_count.gte": 10,
    ...(wanted > 1 ? { page: wanted } : {}),
  });
  const totalPages = Math.min(Number(data.total_pages) || 1, 500);
  return finish((data.results || []).map((r) => toMeta(r, media)), wanted < totalPages);
}

/* ---------------------------------------------------------------- catalog */

const roundRobin = (lists) => {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
};

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

// TMDB answers 20 titles per page. The app asks for 40 at a time and keeps
// scrolling, so a row has to be able to serve *deep* windows — reading page 1
// forever is what made every Explore end after 20 titles.
// TMDB answers 20 titles per page and allows up to 500 pages, so a row is never
// really out of titles — it was the cap here that made "End of catalog" arrive
// after a few hundred, and a small `take` that made some rows stop after ten.
// Demand-driven: `deepen` only walks as far as the window being asked for, so a
// high ceiling costs nothing until someone actually scrolls that far.
const MAX_ROUNDS = 500;           // 500 pages × 20 titles = 10 000 titles
const POOL_TTL = 10 * 60 * 1000;  // a pool is reused for 10 minutes
const MAX_POOLS = 80;             // distinct catalogs kept in memory
const pools = new Map();

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, worker) {
  let next = 0;
  const out = new Array(items.length);
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

function remember(store, key, make) {
  let entry = store.get(key);
  if (!entry || Date.now() - entry.at > POOL_TTL) {
    entry = make();
    store.set(key, entry);
    // Keep the cache bounded — drop the least recently used entries.
    if (store.size > MAX_POOLS) {
      const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, store.size - MAX_POOLS);
      for (const [k] of oldest) store.delete(k);
    }
  }
  entry.at = Date.now();
  return entry;
}

async function fetchRound(entry) {
  const page = entry.rounds + 1;
  entry.rounds = page;
  // One round is one page per spec, and **every** spec is read — no in-flight
  // ceiling, no subset. A round is not a cap on the pool (the pool keeps growing),
  // and a shuffle that carries a spec per country reads all of them.
  const got = await Promise.all(
    entry.specs.map(async (spec, i) => {
      const cap = spec.take ?? Infinity;
      if (entry.lists[i].length >= cap) return false;
      try {
        const res = await get(spec.path, { ...spec.params, page });
        const items = res.results ?? [];
        if (!items.length) return false;
        entry.lists[i].push(...items);
        if (cap !== Infinity) entry.lists[i].length = Math.min(entry.lists[i].length, cap);
        entry.items = null;
        return true;
      } catch {
        return false;
      }
    }),
  );
  return got.some(Boolean);
}

/** The raw, de-duplicated pool — this is what gets cached. */
function poolItems(entry) {
  if (!entry.items) {
    const seen = new Set();
    const out = [];
    for (const item of roundRobin(entry.lists)) {
      if (!item || item.id == null || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    entry.items = out;
  }
  return entry.items;
}

/**
 * Metas are built fresh for every request: the route mutates them downstream
 * (better posters, ratings), so a cached object must never be handed out twice.
 */
const metasFrom = (entry, items) =>
  items
    // SFW is enforced here as well as at the API. `include_adult` only covers the
    // discover endpoints, and it is a hint even there: `/trending`, `/now_playing`,
    // `/airing_today` and `/top_rated` take no such parameter at all, so an adult
    // title TMDB flags on a list item would otherwise reach a safe-for-work app.
    // The flag rides on the raw item, so the filter belongs here, before the meta
    // is built — and after it, nothing downstream can tell the difference.
    .filter((item) => entry.adult || !item.adult)
    .map((item) => toMeta(item, entry.media))
    .filter(Boolean);

const metasFor = (entry) => metasFrom(entry, poolItems(entry));

/**
 * Is this title something other than a US-only production?
 *
 * Used as a second guard on a cross-country shuffle: even a country-scoped query
 * can return a Hollywood co-production, and a draw of nothing but those is the US
 * chart under another flag. An item with no origin on it is left alone (kept as a
 * fallback) rather than guessed at.
 */
const isCrossCountry = (item) => {
  const origins = Array.isArray(item?.origin_country) ? item.origin_country : [];
  if (!origins.length) return false;
  return origins.some((code) => code !== "US");
};

/**
 * Grow the pool until it covers `need` titles, or it runs out.
 *
 * Growing is serialised per catalog: several requests arrive together (three
 * shuffle rows plus the grid), and without this they would each ask TMDB for the
 * same page and each append it.
 */
function deepen(entry, need) {
  const grow = async () => {
    const cap = entry.specs.every((s) => s.take) ? entry.specs.reduce((n, s) => n + s.take, 0) : Infinity;
    const wanted = Math.min(need, cap);
    while (entry.rounds < MAX_ROUNDS && poolItems(entry).length < wanted) {
      if (!(await fetchRound(entry))) break;
    }
    return metasFor(entry);
  };
  const next = (entry.chain || Promise.resolve()).then(grow, grow);
  entry.chain = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * **Every** country the Country card publishes, as origin codes.
 *
 * This used to be a hand-written, region-balanced shortlist — four Asia, three
 * Europe, two Americas, one Africa, one Oceania — and a shortlist is its own cap:
 * whole countries were never reachable, one Africa slot answered for the entire
 * continent, and the same few names came back. The card's own list is the source of
 * truth now, read through the same `countryVocab()` the card and the search panel
 * use, so "every country available in the Country card" is literally the set drawn
 * from — no quota, no region, no favourites.
 */
// **The countries that clear the floor, not the whole table.** Shuffling a row used to
// vary it across every country with a single title, so a draw could come back as titles
// no card has a row for. The pool is now the same list the card and the filters publish.
const SHUFFLE_COUNTRIES = countryVocab().map(([code]) => code);

/** The ids each catalog handed out recently, so a draw does not repeat them. */
const shuffleMemory = new Map();
/** How many past draws are held aside for one catalog. */
const SHUFFLE_MEMORY_DRAWS = 4;

/**
 * The row's own specs, plus a country-scoped one for **every country the card
 * publishes** when the row is discover-based.
 *
 * **The row's filters always come first**: the country is layered *on top of* the
 * row's own parameters, so an Action row stays Action, a Netflix row stays Netflix —
 * only where the titles come from varies. A row that already names a country keeps
 * it (the country is not overridden), and a row that is not a discover query at all
 * (a watchlist, a Top 10, a provider curated list) gets no extra specs: there is
 * nothing to vary without leaving the catalog.
 */
function countryVariedSpecs(specs) {
  const discover = specs.filter((s) => typeof s?.path === "string" && s.path.startsWith("/discover/"));
  if (!discover.length || discover.length !== specs.length) return specs;
  // A row that already names its country keeps it — overriding it is what made a
  // regional row answer with another region's titles. Only a row scoped *nowhere*
  // gets the cross-country treatment.
  const scoped = discover.filter((s) => s.params?.with_origin_country);
  const unscoped = discover.filter((s) => !s.params?.with_origin_country);
  if (!unscoped.length) return specs;
  // One country-scoped row **per country the card publishes** — the country-scoped
  // rows replace the unscoped one instead of being added to it: leaving the
  // US-default chart in the pool is what kept the draw American however many flags
  // were layered on top of it.
  const extra = SHUFFLE_COUNTRIES.map((code) => {
    const base = unscoped[Math.floor(Math.random() * unscoped.length)];
    // No `take` cap: the pool grows like every other pool rather than stopping at
    // half a page per country, which was a limit on what a shuffle could hold.
    return { path: base.path, params: { ...base.params, with_origin_country: code } };
  });
  return [...scoped, ...extra];
}

/**
 * A random sample of a catalog — what the Explore shuffle rows draw from.
 *
 * The pool is the catalog's own rows **plus a few cross-country variants of those
 * same rows**, so a draw is varied without ever leaving the catalog it sits on.
 */
export async function catalogShuffle(media, def, count, opts = {}) {
  const specs = def.entry ? await catalogSpecs(def.entry, media, opts) : [];
  const identity = def.id ?? JSON.stringify(def.entry ?? def);
  // The language is part of the pool identity: the cached items are raw TMDB
  // records, so a pool built in one language must never serve another.
  const language = opts.language || activeLanguage();
  // The order is part of the pool identity: two orders of one OTT row are two
  // different lists, and sharing a pool between them would serve one's titles for
  // the other's request.
  const key = `${media}:${identity}:${opts.adult ? "a" : "s"}:${language}:${opts.sort || ""}`;

  let pool;
  if (specs.length === 1 && specs[0].watchlist) {
    pool = watchlistMetas(specs[0].watchlist, media, 0, 100000);
  } else if (specs.length === 1 && specs[0].custom) {
    pool = customMetas(specs[0].custom, media, 0, 100000);
  } else if (specs.length === 1 && specs[0].episodes) {
    pool = await episodeMetas(media, specs[0].episodes, language, Boolean(opts.adult));
  } else {
    const varied = countryVariedSpecs(specs);
    // The row named no country of its own, so the country-scoped variants *are* the
    // pool — draw from cross-country titles when they are there, and fall back to
    // the whole pool only when they are not.
    const crossCountry = varied !== specs;
    const entry = remember(pools, key, () => ({ at: Date.now(), media, specs: varied, lists: varied.map(() => []), rounds: 0, items: null, adult: Boolean(opts.adult) }));
    // Sample from a pool many times the sample size. Twelve of the top twenty
    // most popular titles is what made one shuffle look like the last one, and
    // like nothing but the biggest names: the pool has to reach well past them
    // before a random draw is worth anything.
    await deepen(entry, Math.max(count * 8, PAGE_SIZE * 4));
    const raw = poolItems(entry);
    const cross = crossCountry ? raw.filter(isCrossCountry) : raw;
    pool = metasFrom(entry, cross.length >= count ? cross : raw);
  }

  const picked = pool.slice();
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  // **A draw does not hand back what the last draws just showed.** Sampling a pool
  // at random repeats titles within a couple of presses — the "same contents again
  // and again" — so the ids of the last few draws are held aside and only used when
  // there is nothing fresh left.
  const recent = new Set(shuffleMemory.get(key) || []);
  const fresh = picked.filter((m) => !recent.has(m.id));
  const draw = (fresh.length >= count ? fresh : picked).slice(0, count);
  shuffleMemory.set(
    key,
    [...draw.map((m) => m.id), ...(shuffleMemory.get(key) || [])].slice(0, SHUFFLE_MEMORY_DRAWS * Math.max(count, 1)),
  );
  if (shuffleMemory.size > 200) shuffleMemory.delete(shuffleMemory.keys().next().value);
  return draw;
}

/**
 * Episode-count rows: TMDB discover cannot filter by episode count, so build them
 * from a pool of shows whose full record carries the count. The pool is cached
 * **once per media type and language** — not once per bucket — so the eight
 * episode rows share one set of detail lookups instead of eight.
 *
 * The buckets are **ranges** (`{ min, max }`) that do not overlap, so "4 Episodes"
 * and "24 Episodes" can never open on the same titles; inside a bucket the most
 * popular titles come first, so a row still opens on names you know.
 */
// Popular shows are overwhelmingly long-running and the newest premieres are the
// ones with few episodes, so the pool pulls **both** ends — and then the most-voted
// shows too, which is where the middle of the ladder (a 20-episode season) actually
// lives. One order alone left the top buckets with only a handful of titles.
const EPISODE_POOL_PAGES = 40;
const EPISODE_POOL_ORDERS = ["first_air_date.desc", "popularity.desc", "vote_count.desc"];
const episodePools = new Map();

/** Every show we know the episode count of, for one media type, cached. */
async function episodeCandidates(media, language = activeLanguage()) {
  const entry = remember(episodePools, `${media}:${language}`, () => ({ shows: null }));
  if (!entry.shows) {
    const t = tmdbPath(media);
    const requests = EPISODE_POOL_ORDERS.flatMap((sort_by) =>
      Array.from({ length: EPISODE_POOL_PAGES }, (_, i) => ({ sort_by, page: i + 1 })),
    );
    const pages = await Promise.all(
      requests.map((params) => get(`/discover/${t}`, { "vote_count.gte": 1, language, ...params }).catch(() => ({ results: [] }))),
    );
    const pool = dedupe(pages.flatMap((r) => r.results ?? []));
    const details = await mapLimit(pool, 12, (it) => get(`/${t}/${it.id}`, { language }).catch(() => null));
    // Cache the *shows* (raw records, with their counts); the metas are built per
    // request because they get mutated.
    entry.shows = details.filter((d) => d && Number.isFinite(d.number_of_episodes));
  }
  return entry.shows;
}

/**
 * The SFW guard, applied to every list this file returns.
 *
 * TMDB filters some endpoints by `include_adult` and simply ignores it on others
 * (`/trending`, `/popular`, `/top_rated`, `/now_playing`, `/airing_today`,
 * `/on_the_air` — the spec has no such parameter there). Leaving those to TMDB is
 * exactly the leak: an adult title could still arrive on a row the switch could not
 * reach. So the flag is carried on the meta and every list is filtered here, which
 * is the one place that cannot be forgotten.
 */
const stripAdult = (metas, adult) => (adult ? metas : metas.filter((m) => !m?.adult));

/** One episode bucket: `{ min, max }` — every show whose count falls inside it. */
async function episodeMetas(media, bucket, language = activeLanguage(), adult = false) {
  const { min = 1, max = Infinity } = bucket || {};
  const shows = await episodeCandidates(media, language);
  return shows
    .filter((d) => d.number_of_episodes >= min && d.number_of_episodes <= max)
    .filter((d) => adult || !d.adult)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .map((d) => toMeta(d, media))
    .filter(Boolean);
}

async function episodesMetas(media, bucket, skip, language, adult, size = PAGE_SIZE) {
  const metas = await episodeMetas(media, bucket, language, adult);
  return metas.slice(skip, skip + size);
}

/* --------------------------------------------------------- the For You deal */

/**
 * How many titles the For You rows keep aside.
 *
 * One full open of the card: four rows of forty per row type. The memory holds the
 * open in progress — and only that — because the rows are all requested at once: the
 * second request is in flight before the first answer lands, so "what did the row
 * above me show" cannot travel on the request. It travels here instead: every row
 * reads and writes the same shared memory, and Node answers the requests one at a
 * time, so row N always sees what rows 1..N-1 dealt.
 *
 * The memory is **per open of the card**, not per card for all time: the page sends an
 * `open` nonce with every row request (see `forYouOpen` in the app), and the memory
 * key carries it. That is what makes re-opens re-deal instead of echo — with one
 * shared key, the second open would find the pools already memorized and top every row
 * back up from the same titles, the "same titles every time I open it" report. A full
 * open can be eight rows of forty (the empty-watchlist fallback), so the memory holds
 * 400; old opens fall off the far end of the map (`> 40` keys are dropped).
 */
const FOR_YOU_MEMORY = 400;
/** The ids each For You card's rows have just handed out, per row type. */
const forYouMemory = new Map();

/** Shuffle a list in place, the same way every draw in this file is shuffled. */
function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * One For You row, **dealt** out of its pool rather than walked down it.
 *
 * Two things made the card repeat itself. Its four catalogs are TMDB
 * recommendation lists, and those lists open on the same popular titles whatever
 * the seed is — so `More Like A` and `More Like B` printed the same names in the
 * same order, which is the "same title in place of …" report. And the pool was
 * walked front to back, so *every* open printed them again.
 *
 * A row is now dealt: the order is **shuffled per roll** (a roll starts at
 * `skip=0`, which is what opening the card does), and the titles the card's other
 * rows have just handed out are pushed to the back, so its four catalogs are four
 * different screens and a second open is a second draw. The order is grown, not
 * rebuilt, when the pool deepens — paging a row must never reshuffle titles the
 * page above already showed.
 *
 * **`exclude` is the third half of that.** Pushing the last draw to the back is
 * memory *between* opens; it says nothing about the row drawn beside this one in the
 * *same* open, and TMDB's recommendation lists genuinely overlap — a title stays
 * popular whatever you seed with, so `More Like A` and `More Like B` can both open on
 * it. The page knows what its sibling rows have already shown, so it sends those ids
 * here and they are dropped from the deal before it is handed over.
 */
function dealForYou(entry, pool, media, def, skip, window, exclude, open) {
  const memoryKey = `${media}:${def.key ?? ""}:${open || ""}`;
  // Grow the dealt order with whatever the pool added since the last request.
  if (!entry.order || entry.order.length < pool.length) {
    const added = [];
    for (let i = entry.order?.length || 0; i < pool.length; i++) added.push(i);
    entry.order = [...(entry.order || []), ...shuffleInPlace(added)];
  }
  if (skip === 0) {
    // A fresh roll: a new order, dealt **past** what the memory holds — the titles
    // the card's other rows just dealt in this open (they wrote them here before this
    // request was answered) and the last draws before that. Pushing them to the back
    // was not enough: TMDB's recommendation lists overlap, so the same popular title
    // opens several rows whatever the seed is, and "later in the order" still meant
    // "on screen twice". Skipped titles leave no holes — a second pass over the
    // order tops the window back up to full, so a row that has to pass over ten is
    // still a row of forty.
    shuffleInPlace(entry.order);
    const recent = new Set(forYouMemory.get(memoryKey) || []);
    const skipped = (id) => recent.has(id) || (exclude?.size && exclude.has(String(id)));
    const out = [];
    for (const i of entry.order) {
      if (out.length >= window) break;
      const m = pool[i];
      if (!m || skipped(m.id)) continue;
      out.push(m);
    }
    if (out.length < window) {
      const have = new Set(out.map((m) => m.id));
      for (const i of entry.order) {
        if (out.length >= window) break;
        const m = pool[i];
        if (!m || have.has(m.id)) continue;
        out.push(m);
      }
    }
    forYouMemory.set(
      memoryKey,
      [...out.map((m) => m.id), ...(forYouMemory.get(memoryKey) || [])].slice(0, FOR_YOU_MEMORY),
    );
    if (forYouMemory.size > 40) forYouMemory.delete(forYouMemory.keys().next().value);
    return out;
  }
  // Paging inside one row walks its own order — the row's own earlier pages must
  // not count against it, so the skip only applies to the opening window.
  const out = entry.order.slice(skip, skip + window).map((i) => pool[i]).filter(Boolean);
  forYouMemory.set(
    memoryKey,
    [...out.map((m) => m.id), ...(forYouMemory.get(memoryKey) || [])].slice(0, FOR_YOU_MEMORY),
  );
  if (forYouMemory.size > 40) forYouMemory.delete(forYouMemory.keys().next().value);
  return out;
}

export async function catalogMetas(media, def, skip, opts = {}) {
  // **How big a window one request hands back.** The default stays the row's own
  // page, but a caller filling out a whole letter (Explore's alphabet rail) can ask
  // for several pages in one round trip instead of one page per trip — bounded so a
  // single request cannot ask TMDB for a whole catalog at once.
  const window = Math.max(1, Math.min(200, Number(opts.count) || PAGE_SIZE));
  const specs = def.entry ? await catalogSpecs(def.entry, media, opts) : [];
  // Key on the catalog's identity *and* its resolved entry — two definitions
  // must never share a pool just because one of them has no id.
  const identity = def.id ?? JSON.stringify(def.entry ?? def);
  const language = opts.language || activeLanguage();
  // See `catalogShuffle`: the sort is part of the pool identity, so switching the
  // OTT dropdown cannot be answered from the other order's pool.
  const key = `${media}:${identity}:${opts.adult ? "a" : "s"}:${language}:${opts.sort || ""}`;

  if (specs.length === 1 && specs[0].episodes) {
    return stripAdult(await episodesMetas(media, specs[0].episodes, skip, language, Boolean(opts.adult), window), Boolean(opts.adult));
  }

  // The watchlist is served from the stored pins, not from TMDB — those are titles
  // *you* pinned, so the SFW switch does not silently take your own list away.
  if (specs.length === 1 && specs[0].watchlist) {
    return watchlistMetas(specs[0].watchlist, media, skip, window);
  }

  // A custom row is served from the titles you put in it, the same way.
  if (specs.length === 1 && specs[0].custom) {
    return customMetas(specs[0].custom, media, skip, window);
  }

  // A pool that only grows: page 2 continues where page 1 stopped, and repeat
  // requests are served from memory. `take` catalogues (the ◆ Top 10 rows) stop
  // at their length, because a Top 10 really does hold ten titles.
  const entry = remember(pools, key, () => ({ at: Date.now(), media, specs, lists: specs.map(() => []), rounds: 0, items: null, adult: Boolean(opts.adult) }));
  // **A For You row is read deeper than its first window.** Its four catalogs are
  // drawn from one shared pool of titles, so a row that only ever held TMDB's first
  // twenty recommendations could not differ from the row beside it — or from itself
  // the next time the card was opened.
  const forYou = def.entry?.kind === "recommend";
  const pool = await deepen(entry, forYou ? Math.max(skip + window, 160) : skip + window);
  if (forYou) {
    // What the card's **other rows** have already shown in this open (see
    // `dealForYou`): a comma-separated list of meta ids, bounded so a crafted URL
    // cannot turn one request into an unbounded filter.
    const exclude = new Set(
      String(opts.exclude || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 500),
    );
    // The card's own open-nonce (see `forYouOpen` in the app): one open, one memory.
    const open = String(opts.open || "").replace(/[^a-z0-9]/gi, "").slice(0, 12);
    return stripAdult(dealForYou(entry, pool, media, def, skip, window, exclude, open), Boolean(opts.adult));
  }
  return stripAdult(pool.slice(skip, skip + window), Boolean(opts.adult));
}

function parseCatalogPath(pathname) {
  // `/skip=N` walks the list, `/shuffle=N` takes a random sample of it.
  const m = pathname.match(/^\/catalog\/(movie|series)\/([^/]+?)(?:\/(skip|shuffle)=(\d+))?\.json$/);
  if (!m) return null;
  const [, type, id, kind, value] = m;
  const def = findCatalog(decodeURIComponent(id), type);
  if (!def) return null;
  return {
    type,
    def,
    skip: kind === "skip" ? Number(value) : 0,
    shuffle: kind === "shuffle" ? Math.min(Math.max(Number(value) || 0, 1), 60) : 0,
  };
}

/* ----------------------------------------------------------------- handler */

/** A session cookie may only be marked `Secure` when it is actually served over TLS. */
const secureOrigin = (origin) => String(origin || "").startsWith("https://");

const json = (res, status, body, maxAge = 0) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    // Anything that answers differently each time says so explicitly — an absent
    // header still lets a browser reuse a heuristic copy.
    "cache-control": maxAge ? `max-age=${maxAge}` : "no-store",
  });
  res.end(payload);
};

/**
 * The languages the app can run in, as TMDB language codes. One setting covers
 * both jobs: the language every row is served in, and the primary subtitle
 * language a player should prefer.
 */
const LANGUAGES = [
  ["en-US", "English (US)"], ["en-GB", "English (UK)"],
  ["hi-IN", "Hindi"], ["bn-IN", "Bengali"], ["ta-IN", "Tamil"], ["te-IN", "Telugu"],
  ["ml-IN", "Malayalam"], ["kn-IN", "Kannada"], ["mr-IN", "Marathi"], ["pa-IN", "Punjabi"], ["ur-PK", "Urdu"],
  ["es-ES", "Spanish"], ["es-MX", "Spanish (Latin America)"], ["pt-BR", "Portuguese (Brazil)"], ["pt-PT", "Portuguese (Portugal)"],
  ["fr-FR", "French"], ["de-DE", "German"], ["it-IT", "Italian"], ["nl-NL", "Dutch"],
  ["pl-PL", "Polish"], ["ru-RU", "Russian"], ["uk-UA", "Ukrainian"], ["cs-CZ", "Czech"],
  ["ro-RO", "Romanian"], ["hu-HU", "Hungarian"], ["el-GR", "Greek"], ["sv-SE", "Swedish"],
  ["da-DK", "Danish"], ["no-NO", "Norwegian"], ["fi-FI", "Finnish"],
  ["tr-TR", "Turkish"], ["ar-SA", "Arabic"], ["he-IL", "Hebrew"], ["fa-IR", "Persian"],
  ["id-ID", "Indonesian"], ["ms-MY", "Malay"], ["th-TH", "Thai"], ["vi-VN", "Vietnamese"], ["fil-PH", "Filipino"],
  ["ja-JP", "Japanese"], ["ko-KR", "Korean"], ["zh-CN", "Chinese (Simplified)"], ["zh-TW", "Chinese (Traditional)"],
];

/**
 * The choices Settings offers: your language, and the country whose services the
 * three regional OTT cards show. `services` says how many rows that country will
 * actually fill, so a country with none is not a silent empty card.
 */
function appOptions() {
  return {
    languages: LANGUAGES.map(([code, label]) => ({ code, label })),
    // A country published nowhere is not offered as a choice either (see
    // `REMOVED_COUNTRY_CODES`): a territory with no rows, no chips and no service
    // rows would otherwise still sit in the picker promising all three.
    countries: COUNTRIES.filter(([, code]) => !REMOVED_COUNTRY_CODES.has(code)).map(([name, code]) => ({
      code,
      name,
      services: localServices(code, "movie").length + localServices(code, "tv").length,
    })),
    // The languages Settings → Subtitles searches in, as `[code, label]` — the shape
    // the app's own dropdown reads. OpenSubtitles is keyed by the two-letter code, a
    // different vocabulary from the locale above, so it is published rather than
    // guessed at on the page.
    subtitleLanguages: SUBTITLE_LANGUAGES.map(([code, label]) => [code, label]),
    // **Whether the server can play a magnet itself.** The player reads this once: with
    // the engine the magnet is streamed from here (real TCP peers, real progress), and
    // without it the page's own WebTorrent is tried and the debrid account is the only
    // thing that makes a public swarm work.
    torrent: torrentState(),
  };
}

/** The watchlist as the app reads it: every pin, plus the per-state counts. */
function watchlistPayload() {
  return {
    items: watchlistList(),
    counts: watchlistCounts(),
    states: STATES.map((id) => ({ id, label: STATE_LABEL[id] || id })),
  };
}

/**
 * The custom rows as the app reads them: every stored title (tagged with its
 * row so one read is enough), plus how many titles each row holds.
 */
/**
 * **Watched titles belong in two places, and this is the rule that keeps them there.**
 *
 * A title you have watched appears in the Watchlist card's **Watched** row and in a
 * **Custom** row you put it in — and nowhere else: not in another Home card, not in
 * another catalog row, not in search. Search in particular has **no filter to reveal
 * them**: the answer for "show me that film again" is the Watched row, and a search that
 * silently hid titles with no way to ask for them back would be the worse trade.
 *
 * The watchlist and custom rows are kept whole (they *are* the two places), so the
 * filter is applied where a row came from TMDB.
 */
export function withoutWatched(metas, keep = false) {
  if (keep) return metas;
  const watched = watchedKeys();
  if (!watched.length) return metas;
  const set = new Set(watched);
  const keyOf = (m) => `${m?.type === "series" ? "series" : "movie"}:${String(m?.id || "")}`;
  return metas.filter((m) => !set.has(keyOf(m)));
}

function customPayload() {
  // `rows` carries each row's name and order as well as its count: the title page draws
  // one "Add to …" button per row, so the names are needed on every read, not only in the
  // settings pane. (`rows` used to be counts alone, which is a subset of this.)
  return { rows: customRowList(), counts: customCounts(), items: customItems() };
}

/**
 * Handle an addon request. Returns true when the request was answered, false
 * when it is not an addon route (so the caller can fall through to static
 * file serving).
 */
export async function handleAddon(req, res, pathname, origin) {
  // Settings are read/written by the app's Settings screen. The keys live on the
  // server so the addon can use them; the response only says whether one is set.
  if (pathname === "/settings" || pathname === "/settings.json") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    if (req.method === "POST") {
      try {
        const patch = await readBody(req);
        updateSettings(patch);
        setKey(tmdbKey());
        // **An add-on you just added has to play now.** Every cached stream answer was
        // read from the old add-on list, so the played title would keep saying "nothing
        // is configured to play anything" for up to five minutes after pasting one.
        if (patch && ("sources" in patch || "enrich" in patch)) clearStreamCache();
        // **An enrichment switch has to change what you see.** Rows, posters and
        // ratings are built from TMDB answers held in memory, so toggling enrichment
        // (or picking a different poster service / provider) rewrites nothing until
        // those answers are dropped — which is exactly "enrichment does nothing".
        if (patch && ("enrich" in patch || "posters" in patch || "providers" in patch || "ratings" in patch)) clearTmdbCache();
        json(res, 200, { ...publicSettings(), options: appOptions(), dns: publicDns(), customSites: publicSites(), prefs: getPrefs(), account: { configured: authConfigured(), providers: authProviders(), local: localAccount(), user: readSession(req) } });
      } catch (err) {
        json(res, 400, { error: String(err?.message || err) });
      }
      return true;
    }
    json(res, 200, { ...publicSettings(), options: appOptions(), dns: publicDns(), customSites: publicSites(), prefs: getPrefs(), account: { configured: authConfigured(), providers: authProviders(), local: localAccount(), user: readSession(req) } });
    return true;
  }

  // Live check for the poster service configured in Settings.
  if (pathname === "/posters/check") {
    json(res, 200, await checkPosterService());
    return true;
  }

  // Inspect an add-on / plugin / repository **server-side**. This is what makes
  // third-party sources work in the app: the browser cannot read a foreign
  // host's manifest.json (CORS), and a repo lives on raw.githubusercontent.com.
  if (pathname === "/api/source") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    try {
      const { type, url } = await readBody(req);
      json(res, 200, await inspectSource(String(type || "stremio"), String(url || "")));
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  // A real release calendar: everything landing in a given month.
  {
    const m = pathname.match(/^\/calendar\/(movie|series)\/(\d{4}-\d{2})\.json$/);
    if (m) {
      const [, type, month] = m;
      const adult = new URL(req.url ?? "/", "http://localhost").searchParams.get("adult") === "1";
      try {
        const data = await calendarMonth(type, month, { adult });
        if (!data) {
          json(res, 400, { error: "month must be YYYY-MM" });
          return true;
        }
        await applyPosters(data.metas);
        await enrichRatings(data.metas);
        json(res, 200, data, 900);
      } catch (err) {
        console.error(`[addon] calendar ${type}/${month} failed:`, err.message);
        json(res, 200, { month, type, days: 0, metas: [] });
      }
      return true;
    }
  }

  // Verify a stored provider key by calling the provider.
  if (pathname === "/providers/verify") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    try {
      const { name } = await readBody(req);
      const s = getSettings();
      const key = s.providers?.[name]?.key || (name === "tmdb" ? tmdbKey() : "");
      json(res, 200, await verifyProvider(name, key));
    } catch (err) {
      json(res, 400, { ok: false, text: String(err?.message || err) });
    }
    return true;
  }

  // **Debrid.** A torrent stream has no address of its own: an add-on publishes an
  // info hash, and a browser cannot join a public swarm (the peers speak TCP/UDP,
  // which a page cannot dial). The server therefore turns the magnet into a direct
  // HTTPS link through the user's own debrid account and hands the player something
  // it can play like any other stream.
  if (pathname === "/debrid/verify") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    try {
      const { name, key } = await readBody(req);
      json(res, 200, await verifyDebrid(name, key));
    } catch (err) {
      json(res, 400, { ok: false, text: String(err?.message || err) });
    }
    return true;
  }

  /* --------------------------------------------------------------- signing in */

  // Who this browser is, if anyone. **A whole account system waits on this except for
  // the profile it names** — see `addon/auth.mjs` for what is stored (a name, an address,
  // a picture; never a token and never a password).
  if (pathname === "/auth/me") {
    json(res, 200, { ok: true, configured: authConfigured(), providers: authProviders(), local: localAccount(), user: readSession(req) });
    return true;
  }

  /**
   * **This machine's own sign-in — the one that works with nothing set up.**
   *
   * A name (or nothing at all, to come back as the account this machine already has) and
   * an optional address. It answers with the session cookie a provider's sign-in would
   * have set, so everything downstream — `/auth/me`, the settings payload, sign-out — is
   * the same path for both. `POST`, because it makes a session; a GET that signs somebody
   * in is a link a page can be tricked into following.
   */
  if (pathname === "/auth/local" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { user, sessionId } = signInLocal(body);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": sessionCookie(sessionId, secureOrigin(origin)),
      });
      res.end(JSON.stringify({ ok: true, user, local: localAccount() }));
    } catch (err) {
      json(res, 400, { ok: false, error: String(err?.message || err) });
    }
    return true;
  }

  // **Forget it.** Signing out ends the session; this takes the account off the machine
  // as well, which is the only way to stop the card offering the name back.
  if (pathname === "/auth/local/forget" && req.method === "POST") {
    forgetLocal();
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": clearCookie(secureOrigin(origin)),
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // Sign out of the session this browser is carrying.
  if (pathname === "/auth/signout") {
    signOut(req);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": clearCookie(secureOrigin(origin)) });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // **Off to the provider.** This is a plain redirect, not a JSON answer: the whole point
  // is to leave this origin, and a fetch cannot do that on the user's behalf.
  if (pathname.startsWith("/auth/") && pathname.endsWith("/start")) {
    const provider = pathname.slice("/auth/".length, -"/start".length);
    const next = new URL(req.url ?? "/", "http://localhost").searchParams.get("next") || "";
    const started = startUrl(provider, origin, next);
    if (!started) {
      // Not configured, or not a provider this build offers: back to the app with the
      // reason, rather than a blank page from the provider's error screen.
      res.writeHead(302, { location: `/app/#/settings?signin=${encodeURIComponent(provider)}` });
      res.end();
      return true;
    }
    res.writeHead(302, { location: started.url, "cache-control": "no-store" });
    res.end();
    return true;
  }

  // ...and back. The code is spent here and turned into a session cookie.
  if (pathname.startsWith("/auth/") && pathname.endsWith("/callback")) {
    const provider = pathname.slice("/auth/".length, -"/callback".length);
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    try {
      const done = await finish(provider, {
        code: params.get("code") || "",
        state: params.get("state") || "",
        origin,
      });
      const where = done.next && done.next.startsWith("/") ? done.next : "/app/#/settings";
      res.writeHead(302, {
        location: where,
        "set-cookie": sessionCookie(done.sessionId, secureOrigin(origin)),
        "cache-control": "no-store",
      });
      res.end();
    } catch (err) {
      const why = encodeURIComponent(String(err?.message || err).slice(0, 160));
      res.writeHead(302, { location: `/app/#/settings?signin_error=${why}`, "cache-control": "no-store" });
      res.end();
    }
    return true;
  }

  if (pathname === "/debrid/resolve") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    try {
      const { magnet, infoHash, name } = await readBody(req);
      // Always 200: a stream that could not be resolved is an answer, not a
      // transport failure, and the body carries which service said what.
      json(res, 200, await resolveMagnet({ magnet, infoHash, name }));
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  // Which debrid services this build offers, and which would answer right now.
  if (pathname === "/debrid.json") {
    json(res, 200, { services: DEBRID_SERVICES, ready: debridReady() });
    return true;
  }

  /**
   * **A page the add-ons do not cover.** `extractStreams` (scraper/) runs server-side for
   * the same reason the streams route does: a browser cannot read another host's page, and
   * the last tier is a real browser that has to live here. The trace comes back with the
   * list, so "nothing found" can say *which* tiers were tried instead of being a shrug.
   */
  if (pathname === "/extract") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    try {
      const { url, referer } = await readBody(req);
      const trace = [];
      const streams = await extractStreams(String(url || ""), { trace, cookies: undefined, referer });
      json(res, 200, {
        ok: streams.length > 0,
        url: String(url || ""),
        streams,
        trace,
        tier: streams[0]?.source || "",
        // **A bot check is passed back as its own fact**, so the UI can offer the manual
        // step instead of reporting "nothing found" for a site that asked for a person.
        needsVerification: streams.needsVerification || null,
        message: streams.length ? "" : trace[trace.length - 1] || "No streams found.",
      });
    } catch (err) {
      json(res, 200, { ok: false, streams: [], trace: [], message: String(err?.message || err) });
    }
    return true;
  }

  // The plugins a user pasted: list them, add one by URL, forget one.
  if (pathname === "/scraper/plugins.json") {
    json(res, 200, { plugins: listPlugins(), sessions: sessionDomains() });
    return true;
  }

  if (pathname === "/scraper/plugins" && req.method === "POST") {
    try {
      const { url, name, domains } = await readBody(req);
      json(res, 200, await addPlugin({ url, name, domains }));
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/scraper/plugins/remove" && req.method === "POST") {
    try {
      const { name } = await readBody(req);
      json(res, 200, { ok: removePlugin(String(name || "")), plugins: listPlugins() });
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/scraper/sessions/clear" && req.method === "POST") {
    try {
      const { domain } = await readBody(req);
      json(res, 200, { ok: true, dropped: clearSession(domain ? String(domain) : "") });
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  /* ------------------------------------------------------------------ DNS */

  // Which resolver is in force, and what it applies to.
  if (pathname === "/dns.json") {
    json(res, 200, { ...publicDns(), scope: dnsScope() });
    return true;
  }

  if (pathname === "/dns" && req.method === "POST") {
    try {
      const patch = await readBody(req);
      updateDns(patch || {});
      json(res, 200, { ok: true, dns: publicDns(), servers: activeDnsServers(), scope: dnsScope(), message: activeDnsServers().length ? `Resolving through ${activeDnsServers().join(", ")} from now on.` : "The system resolver is in use again." });
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  // The Settings button: resolve the *same* name both ways and report both answers.
  if (pathname === "/dns/test") {
    try {
      const { host } = req.method === "POST" ? await readBody(req).catch(() => ({})) : { host: "" };
      json(res, 200, await testDns(String(host || "google.com")));
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  /* ------------------------------------------------------ Custom Websites */

  if (pathname === "/custom-sites.json") {
    json(res, 200, { ...publicSites(), prefs: getPrefs() });
    return true;
  }

  if (pathname === "/custom-sites/add" && req.method === "POST") {
    try {
      const body = await readBody(req);
      // **The whole list comes back, not just the new row.** The pane redraws from this
      // answer, so a response without `sites` left the category it had just added to
      // looking empty until the next full settings fetch.
      // A site is added from **one URL box** and tagged afterwards; `tags` is what the
      // pane sends, `category` is what an older page or a repository entry still sends.
      const added = await addSite({
        url: body.url,
        category: body.category,
        tags: body.tags,
        categories: body.categories,
        searchPattern: body.searchPattern || null,
      });
      json(res, 200, { ...added, sites: listSites() });
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  // A sample search URL into a pattern, for a site whose form could not be detected.
  if (pathname === "/custom-sites/pattern" && req.method === "POST") {
    try {
      const { sample, title, url, category } = await readBody(req);
      const pattern = patternFromSample(String(sample || ""), String(title || ""));
      if (!pattern) {
        json(res, 200, { ok: false, message: "That URL has no query parameters to copy a pattern from." });
        return true;
      }
      if (url) {
        const withSite = await addSite({ url: String(url), category: category || "other", searchPattern: pattern });
        json(res, 200, { ok: true, pattern, ...withSite, sites: listSites() });
        return true;
      }
      json(res, 200, { ok: true, pattern });
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/custom-sites/detect" && req.method === "POST") {
    try {
      const { url } = await readBody(req);
      json(res, 200, await detectSearchPattern(String(url || "")));
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/custom-sites/update" && req.method === "POST") {
    try {
      const { url, category, patch } = await readBody(req);
      json(res, 200, updateSite({ url, category, patch: patch || {} }));
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/custom-sites/remove" && req.method === "POST") {
    try {
      const { url } = await readBody(req);
      json(res, 200, removeSite({ url }));
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/custom-sites/repositories" && req.method === "POST") {
    try {
      const { url } = await readBody(req);
      json(res, 200, await addRepository({ url }));
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/custom-sites/repositories/remove" && req.method === "POST") {
    try {
      const { url } = await readBody(req);
      json(res, 200, removeRepository({ url }));
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  /**
   * **Search-on-Play.** The sites the user added, searched for the title being played:
   * every stream comes back tagged with the site's domain, and every site reports what it
   * did — so a site that failed says why instead of silently adding nothing.
   *
   * **Started, not awaited.** The search is allowed a long budget (each site gets a slice
   * of it), and a request held open that long is one the proxy in front of this server
   * answers with **502** — which is what "Custom Sites could not be searched — HTTP 502"
   * was. A `POST` starts the search and returns its id; the page then asks for that job
   * until it is done, so every request is short.
   */
  if (pathname === "/custom-sites/streams.json") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        const job = startSearchOnPlay({
          title: body.title || body.name || "",
          year: body.year || "",
          type: body.type === "series" ? "series" : "movie",
          trace: [],
        });
        json(res, 200, searchJob(job.id));
      } else {
        const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id") || "";
        const job = searchJob(id);
        // A job this server has never heard of (a restart, or a stale page) is not an
        // error the page should keep polling for.
        json(res, 200, job || { ok: false, running: false, streams: [], sites: [], message: "That search is no longer running — press Play again." });
      }
    } catch (err) {
      console.error("[addon] custom-sites search failed:", err.message);
      json(res, 200, { ok: false, running: false, streams: [], sites: [], message: `Custom Sites could not be searched — ${err.message}` });
    }
    return true;
  }

  /* ------------------------------------------------------------ preferences */

  if (pathname === "/prefs.json") {
    json(res, 200, getPrefs());
    return true;
  }

  if (pathname === "/prefs" && req.method === "POST") {
    try {
      const patch = await readBody(req);
      json(res, 200, { ok: true, prefs: updatePrefs(patch || {}) });
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  /* --------------------------------------------------------------- the pipe */

  /**
   * **The stream proxy.** A scraped file usually wants the page as its `Referer` and the
   * site's cookies; a browser can send neither. So the server fetches it — and rewrites a
   * playlist's own URIs to come back through here, so a stream's segments carry the same
   * two headers as its first request.
   */
  if (pathname === "/stream/proxy") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    await handleProxy(req, res, { url: params.get("url") || "", ref: params.get("ref") || "" });
    return true;
  }

  // **A torrent, played by the server.** The magnet is resolved here and the file is
  // piped to the browser with range support, because a page cannot join a TCP swarm and
  // a `<video>` element seeks by asking for a byte range. Nothing is stored: the swarm is
  // dropped when it has been idle. A debrid account is still tried first by the player —
  // a cached torrent there starts instantly, while this has to find real peers.
  if (pathname === "/stream/torrent") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    await handleTorrentStream(req, res, {
      magnet: params.get("magnet") || "",
      infoHash: params.get("ih") || "",
      fileIdx: params.get("idx"),
    });
    return true;
  }

  // **Start the swarm, and answer at once.** Joining one takes as long as it takes, and a
  // request that waits for it is a request the proxy in front of this server gives up on —
  // which is where "HTTP 502" on a torrent came from. The player asks to prepare, then
  // polls `/torrent/status` until the file is known, and only then points the element at
  // `/stream/torrent` (which is instant by then).
  if (pathname === "/torrent/prepare") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    json(res, 200, { ok: true, ...prepareTorrent({ magnet: params.get("magnet") || "", infoHash: params.get("ih") || "" }) });
    return true;
  }

  // The player's live readout for a swarm it started: state, peers, progress, the file.
  if (pathname === "/torrent/status") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    json(res, 200, { ok: true, status: torrentStatus(params.get("ih") || "", params.get("idx")) });
    return true;
  }

  /* --------------------------------------------------- manual verification */

  // When every tier was stopped by a bot check, the site is asking for a person. This
  // opens a window on the machine the server runs on; the user solves it and says so.
  if (pathname === "/scraper/verify" && req.method === "POST") {
    try {
      const { url } = await readBody(req);
      json(res, 200, await startManualVerification(String(url || "")));
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/scraper/verify/done" && req.method === "POST") {
    try {
      const { sessionId } = await readBody(req);
      json(res, 200, await finishManualVerification(String(sessionId || "")));
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/scraper/verify/cancel" && req.method === "POST") {
    try {
      const { sessionId } = await readBody(req);
      json(res, 200, await cancelManualVerification(String(sessionId || "")));
    } catch (err) {
      json(res, 200, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/scraper/verify.json") {
    json(res, 200, { sessions: manualSessions(), message: MANUAL_MESSAGE });
    return true;
  }

  // **Subtitles a stream does not carry.** OpenSubtitles is searched on the server
  // (the API needs a key that must not reach the page, and the file it returns is
  // often a ZIP), and the chosen one is served back from here as WebVTT — which is
  // what a `<track>` element can actually read.
  if (pathname === "/subtitles/verify") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    // The body names which service to check; without one, the first that is set up.
    let name = "";
    try {
      name = String((await readBody(req)).name || "");
    } catch {
      /* an empty body means "check whatever is ready" */
    }
    json(res, 200, await verifySubtitles(name));
    return true;
  }

  // Which languages the catalogue is searched in, for the Settings picker.
  if (pathname === "/subtitles.json") {
    json(res, 200, { languages: SUBTITLE_LANGUAGES, ...publicSettings().subtitles });
    return true;
  }

  if (pathname === "/subtitles/search.json") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    // The IMDb id is resolved **here** from the TMDB id when the app does not have one:
    // OpenSubtitles matches on IMDb and on little else, and the page only ever knows a
    // TMDB id for the title it is playing.
    const type = params.get("type") === "series" ? "series" : "movie";
    // The TMDB id the page holds, and the IMDb id derived from it: the services index on
    // either, so both travel rather than one being thrown away.
    const tmdbId = String(params.get("id") || "").replace(/^tmdb:/, "");
    let imdb = params.get("imdb") || "";
    if (!imdb && tmdbId) {
      imdb = await imdbId({ id: tmdbId, type }).catch(() => "") || "";
    }
    try {
      json(res, 200, await searchSubtitles({
        imdb,
        tmdb: tmdbId,
        type,
        season: params.get("season") || "",
        episode: params.get("episode") || "",
        name: params.get("name") || "",
        year: params.get("year") || "",
        language: params.get("lang") || "",
        provider: params.get("provider") || "",
      }));
    } catch (err) {
      console.error("[addon] subtitles search failed:", err.message);
      json(res, 200, { ok: false, ready: true, results: [], message: `Could not search for subtitles — ${err.message}` });
    }
    return true;
  }

  {
    // The **service** is part of the path, because the same build searches several: a
    // result carries the service it came from and its short token, and only a cold
    // service+token is fetched — re-picking one already downloaded spends nothing.
    const m = pathname.match(/^\/subtitles\/([a-z]+)\/([A-Za-z0-9_.-]+)\.vtt$/);
    if (m) {
      const [, provider, ref] = m;
      const hit = cachedSubtitle(provider, ref);
      const result = hit || (await downloadSubtitle(ref, { provider }));
      if (!result?.ok) {
        json(res, result?.ok === false ? 404 : 500, { error: result?.message || "That subtitle could not be downloaded." });
        return true;
      }
      res.writeHead(200, {
        "content-type": "text/vtt; charset=utf-8",
        "cache-control": "private, max-age=3600",
      });
      res.end(result.vtt);
      return true;
    }
  }

  // Provider state, for the Settings screen and diagnostics.
  if (pathname === "/providers.json") {
    const s = getSettings();
    json(res, 200, {
      ...publicSettings(),
      activeKey: tmdbKey() ? "tmdb" : null,
      envKey: Boolean(process.env.TMDB_API_KEY),
    });
    return true;
  }

  if (pathname === "/addon-status.json") {
    const keys = providerKeys();
    json(res, 200, {
      addon: buildManifest(origin).name,
      profile: getSettings().profile,
      tmdbKey: hasKey(),
      tvdbKey: Boolean(keys.tvdb),
      mdblistKey: Boolean(keys.mdblist),
      mdblistEnriching: Boolean(keys.mdblist),
      posters: postersEnabled(),
      safe: getSettings().safe,
      region: activeRegion(),
      language: activeLanguage(),
      // The content source is reported twice on purpose: what was asked for, and
      // what is actually in force (TVDB without a key falls back to TMDB), plus
      // how many titles it upgraded — so "is TVDB really supplying this?" is a
      // question the status route can answer.
      contentSource: activeContentSource(),
      contentSourceActive: contentSourceActive(),
      contentSourceStats: contentSourceStats(),
      catalogs: catalogDefs().length,
      regionalServices: localServices(activeCountry(), "movie").length + localServices(activeCountry(), "tv").length,
      watchlistFile: fs.existsSync(WATCHLIST_FILE),
      watchlist: watchlistCounts(),
      customRows: customCounts(),
      aiProvider: aiState().provider,
      aiReady: aiState().ready,
      // **What the app has survived.** A page under scraping whose own script throws is
      // absorbed rather than fatal (`addon/guards.mjs`); this says how many, and what
      // the last few were, so "the server died while searching my sites" is answerable
      // from the status route instead of from a missing reply.
      absorbedErrors: guardState(),
      // **Is the browser tier usable here?** Custom Websites whose search page draws its
      // own results need it, so "the site found nothing" and "this machine cannot launch
      // a browser" have to be tellable apart. (`npx playwright install-deps chromium`
      // installs what a host needs for it.)
      browserTier: browserUnavailableReason() || "ready",
    });
    return true;
  }

  // The watchlist: the titles the user pinned, and how far they are with them.
  // It is stored here so the addon can publish the same rows the app shows.
  if (pathname === "/watchlist.json" || pathname === "/watchlist") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const item = body.item || {};
        const state = body.state;
        if (body.remove || state === null) json(res, 200, { ...watchlistUnpin(item), ...watchlistPayload() });
        else if (!isState(state)) json(res, 400, { ok: false, text: `unknown state ${state}`, ...watchlistPayload() });
        else json(res, 200, { ...watchlistPin(item, state), ...watchlistPayload() });
      } catch (err) {
        json(res, 400, { ok: false, text: String(err?.message || err) });
      }
      return true;
    }
    json(res, 200, watchlistPayload());
    return true;
  }

  // Custom rows: the titles you added yourself, after the watchlist states.
  if (pathname === "/customrows.json" || pathname === "/customrows") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const row = body.row || DEFAULT_ROW;
        const item = body.item || {};
        // One card, or the whole row (Settings → Custom Rows clears a row in one go).
        if (body.clearRow) json(res, 200, { ...customClearRow(row), ...customPayload() });
        else if (body.remove) json(res, 200, { ...customRemove(row, item), ...customPayload() });
        else json(res, 200, { ...customAdd(row, item), ...customPayload() });
      } catch (err) {
        json(res, 400, { ok: false, text: String(err?.message || err) });
      }
      return true;
    }
    json(res, 200, customPayload());
    return true;
  }

  /**
   * **Settings → Custom Rows: the rows themselves.**
   *
   * The rows the Custom card publishes — add one, rename it, delete it, move it up or
   * down. What is *inside* a row is deliberately not part of this API: a card goes into a
   * row from a title page, and this is where the row's name and place are kept.
   */
  if (pathname === "/custom-rows.json") {
    json(res, 200, { ok: true, rows: customRowList(), max: MAX_CUSTOM_ROWS });
    return true;
  }

  if (pathname.startsWith("/custom-rows/") && req.method === "POST") {
    try {
      const body = await readBody(req);
      const action = pathname.slice("/custom-rows/".length);
      const result =
        action === "add" ? customAddRow(body.name)
        : action === "rename" ? customRenameRow(body.id, body.name)
        : action === "delete" ? customDeleteRow(body.id)
        : action === "move" ? customMoveRow(body.id, Number(body.delta) || 0)
        : { ok: false, message: `Unknown action “${action}”.` };
      json(res, 200, { ...result, rows: customRowList(), max: MAX_CUSTOM_ROWS });
    } catch (err) {
      json(res, 400, { ok: false, message: String(err?.message || err) });
    }
    return true;
  }

  // The AI provider state (never the keys) and its two live calls.
  if (pathname === "/ai.json") {
    json(res, 200, aiState());
    return true;
  }

  // **A question about one title**, which is a different job from `/ai/ask`: that one
  // turns a sentence into a search, this one answers. Same providers, same key.
  if (pathname === "/ai/about" && req.method === "POST") {
    try {
      const body = await readBody(req);
      json(res, 200, await askAbout(String(body.question || ""), body.context || {}));
    } catch (err) {
      json(res, 400, { ok: false, text: String(err?.message || err) });
    }
    return true;
  }

  if (pathname === "/ai/ask" || pathname === "/ai/verify" || pathname === "/ai/models") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    try {
      const body = await readBody(req);
      const provider = String(body.provider || "");
      const result = pathname === "/ai/ask"
        ? await askAI(String(body.prompt || ""))
        : pathname === "/ai/models"
          ? await aiModels(provider || aiProviderName())
          : await verifyAI(provider, body.key ? String(body.key) : undefined);
      json(res, 200, result);
    } catch (err) {
      json(res, 400, { ok: false, text: String(err?.message || err) });
    }
    return true;
  }

  // Title search, backing the search screen and the AI box. The addon
  // advertises only the `catalog` resource, so this is a plain server route
  // rather than a Stremio `search` resource.
  if (pathname === "/search.json") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const query = (params.get("q") || "").trim();
    const adult = params.get("adult") === "1";
    const filters = parseFilters(params);
    // A screen with no text and no filter is an empty screen, not a query that
    // happens to match nothing.
    const browsing = !query && hasFilters(filters);
    setKey(tmdbKey());
    if ((!query && !browsing) || !hasKey()) {
      json(res, 200, { query, metas: [], filters: filtersPayload(filters) });
      return true;
    }
    // `start` is the window the screen is asking for: 0 is the first, and each
    // further window continues where the last one stopped. Nothing is capped —
    // the client keeps asking until TMDB runs out.
    const start = Math.max(0, Number(params.get("start")) || 0);
    try {
      const { metas, next } = query
        ? await searchTitles(query, filters, { adult, start })
        : await browseTitles(filters, { adult, start });
      // **Search never shows a watched title**, and there is deliberately no filter to
      // bring them back: the Watched row on the Watchlist card is where they are.
      const kept = withoutWatched(stripAdult(metas, adult));
      metas.length = 0;
      metas.push(...kept);
      await applyPosters(metas);
      await applyContentSource(metas);
      await enrichRatings(metas);
      json(res, 200, { query, metas, next, filters: filtersPayload(filters) }, 300);
    } catch (err) {
      console.error(`[addon] search ${query || "(browse)"} failed:`, err.message);
      json(res, 200, { query, metas: [], filters: filtersPayload(filters) });
    }
    return true;
  }

  /* -------------------------------------------------------- one title, in full */

  // The **title page**: everything TMDB knows about one film or show, in the shape
  // the page draws it — the credits, the studios, the franchise, the seasons and the
  // recommendations — each carrying the id of the list it opens, so every name on
  // the page is a way into that name's own catalog.
  {
    const m = pathname.match(/^\/title\/(movie|series)\/(\d+)\.json$/);
    if (m) {
      const [, type, id] = m;
      setKey(tmdbKey());
      if (!hasKey()) {
        json(res, 200, { ok: false, error: "no TMDB key" });
        return true;
      }
      try {
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const payload = await titlePayload(type, id, params.get("adult") === "1");
        json(res, 200, payload, 600);
      } catch (err) {
        console.error(`[addon] title ${type}/${id} failed:`, err.message);
        json(res, 200, { ok: false, error: err.message });
      }
      return true;
    }
  }

  // One name's own catalog: a person's credits, a studio's films, a franchise's
  // parts, or one season's episodes. The title page links every one of them here.
  {
    const m = pathname.match(/^\/list\/(person|company|collection|season|network|genre|keyword)\/([^/]+)(?:\/(\d+))?\.json$/);
    if (m) {
      const [, kind, first, second] = m;
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const media = params.get("type") === "series" ? "series" : "movie";
      const adult = params.get("adult") === "1";
      setKey(tmdbKey());
      if (!hasKey()) {
        json(res, 200, { metas: [] });
        return true;
      }
      try {
        const page = Number(params.get("page")) || 1;
        json(res, 200, await listPayload(kind, first, second, media, adult, page), 300);
      } catch (err) {
        console.error(`[addon] list ${kind}/${first} failed:`, err.message);
        json(res, 200, { metas: [] });
      }
      return true;
    }
  }

  // **A Live TV channel's streams**, from the add-ons you added: the live form of the
  // request above (`/stream/channel/<id>.json`), because a channel has no IMDb id.
  {
    const m = pathname.match(/^\/streams\/channel\/(.+)\.json$/);
    if (m) {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      try {
        json(
          res,
          200,
          await channelStreams({
            id: decodeURIComponent(m[1]),
            name: params.get("name") || "",
            epgId: params.get("epgId") || "",
            // A channel that came from an add-on carries the add-on and its own id.
            source: params.get("source") || "",
            type: params.get("type") || "",
            mediaId: params.get("mediaId") || "",
          }, { force: params.get("force") === "1" }),
        );
      } catch (err) {
        console.error(`[addon] channel streams ${m[1]} failed:`, err.message);
        json(res, 200, { ok: false, reason: "error", streams: [], sources: [], message: err.message });
      }
      return true;
    }
  }

  // **The streams for one title**, read from the add-ons you added (see
  // `addon/streams.mjs`). Server-side because a browser cannot call another host's
  // stream endpoint, and because the add-on list lives in the server's settings.
  {
    const m = pathname.match(/^\/streams\/(movie|series)\/(\d+)\.json$/);
    if (m) {
      const [, type, id] = m;
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      try {
        json(
          res,
          200,
          await streamsFor(type, id, {
            name: params.get("name") || "",
            force: params.get("force") === "1",
            // An episode's own streams: `?season=2&episode=5`.
            season: params.get("season") || "",
            episode: params.get("episode") || "",
          }),
        );
      } catch (err) {
        console.error(`[addon] streams ${type}/${id} failed:`, err.message);
        json(res, 200, { ok: false, reason: "error", streams: [], sources: [], message: err.message });
      }
      return true;
    }
  }

  /* ------------------------------------------------------- Live TV & Sports */

  // The channel list: the Live TV profile's catalog. `group` picks one of the
  // playlist's own categories (Sports, News, …), `q` filters by name, and
  // `country` by the country a playlist names in the channel's id.
  if (pathname === "/live/channels.json") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const group = params.get("group") || "";
    // One country (`country=US`) or a picked set (`countries=US,GB`). A picked set
    // is what the country setting hands over, so the Guide, the Categories card and
    // the channel rows all read the same slice of the directory.
    const wanted = [params.get("country") || "", ...(params.get("countries") || "").split(",")]
      .flatMap((c) => countrySpellings(c))
      .filter(Boolean);
    const needle = (params.get("q") || "").trim().toLowerCase();
    const list = await liveChannels({ force: params.get("force") === "1" });
    // **Your add-ons' live channels are Live TV too.** A live Stremio add-on publishes
    // its channels as catalogues, and a Stremio app shows them beside the operator
    // lineup. Merged here (not stored in the lineup cache) so they ride the add-on's own
    // 30-minute cache and an add-on added a minute ago appears at once.
    const fromAddons = params.get("addons") === "0" ? { channels: [] } : await liveAddonChannels().catch(() => ({ channels: [] }));
    const lineup = [
      ...(list.channels || []),
      ...(fromAddons.channels || []).filter((c) => !(list.channels || []).some((k) => k.id === c.id)),
    ];
    const channels = lineup.filter(
      (c) =>
        (!group || (c.groups || []).includes(group)) &&
        (!wanted.length || wanted.includes(String(c.country || "").toUpperCase())) &&
        (!needle || c.name.toLowerCase().includes(needle)),
    );
    json(res, 200, {
      channels: channels.slice(0, Number(params.get("limit")) || 100000),
      total: channels.length,
      groups: list.groups || [],
      updated: list.at || 0,
      error: list.error || "",
    }, 300);
    return true;
  }

  // The guide: the next `hours` of programmes per channel id, plus the lineup the
  // grid is drawn against. Empty programmes with `epg: false` is the honest answer
  // when no XMLTV source is configured.
  if (pathname === "/live/guide.json") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const guide = await liveGuide({
      hours: Number(params.get("hours")) || 6,
      force: params.get("force") === "1",
      countries: params.get("countries") || "",
    });
    json(res, 200, guide, 300);
    return true;
  }

  // The directory's country table, for the settings screen's country picker.
  if (pathname === "/live/countries.json") {
    json(res, 200, await liveCountries(), 86400);
    return true;
  }

  if (pathname === "/live/status.json") {
    json(res, 200, await liveStatus(), 60);
    return true;
  }

  // The filter panel's own vocabulary — what the search screen draws its rows
  // from, so the app never hard-codes a genre name TMDB does not know.
  // **Never cached.** This is UI vocabulary, not data: an hour-long cache meant the
  // app could still be drawing last release's Time chips ("2015-2011", "2010-2000")
  // long after every year had its own — the reported "you didn't do every year
  // individual" was the browser showing a stored copy.
  if (pathname === "/search/filters.json") {
    json(res, 200, { filters: SEARCH_FILTERS }, 0);
    return true;
  }

  if (pathname === "/manifest.json") {
    // **The For You rows are built from titles**, and the card is published with the
    // list the app is about to read. Priming the trending seeds here (cached for half
    // an hour) is what makes those rows real "More like …" rows on a watchlist that
    // is still empty, instead of the standing genre rows.
    setKey(tmdbKey());
    await primeTrendingSeeds().catch(() => {});
    json(res, 200, buildManifest(origin));
    return true;
  }

  if (pathname === "/collections.json") {
    setKey(tmdbKey());
    await primeTrendingSeeds().catch(() => {});
    json(res, 200, collectionsPayload(origin.replace(/\/$/, "")));
    return true;
  }

  // Keep the TMDB client on the key configured in Settings (falls back to env).
  setKey(tmdbKey());

  const parsed = parseCatalogPath(pathname);
  if (!parsed) return pathname.startsWith("/catalog/") ? (json(res, 404, { metas: [] }), true) : false;
  // A retired or unknown catalog id is a 404, not a crash: the id is matched by
  // shape, so `parsed.def` can be null, and the error handler below reads
  // `parsed.def.id` — which would throw from inside the catch.

  if (!parsed.def) {
    json(res, 404, { metas: [] });
    return true;
  }

  if (!hasKey()) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn(
        "[addon] TMDB_API_KEY is not set — catalogs will be empty. Add it in Settings → Environment.",
      );
    }
    json(res, 200, { metas: [] });
    return true;
  }

  // The app's SFW/NSFW setting rides along as ?adult=1 on the catalog request,
  // and its language as ?lang= — which also means a language switch is a
  // different URL, so the browser can never answer it from the previous one.
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const adult = params.get("adult") === "1";
  const language = params.get("lang") || activeLanguage();
  // **The OTT cards' own dropdown.** The sort rides on the URL rather than on the
  // settings, because it is a way of *reading* a row (the same service, five questions),
  // not a preference the whole app should carry — and it is part of the pool key below,
  // so two orders of one row never share a cache.
  const sort = isOttSort(params.get("sort")) ? params.get("sort") : "";
  // **The For You card's sibling rows.** `?exclude=` carries the meta ids the card's
  // other rows have already put on screen in this open, so the same title cannot
  // appear in two of its rows (see `dealForYou`). It rides on the URL rather than in
  // the pool key: it changes which *slice* of the pool this request gets, not which
  // pool the row is.
  const exclude = params.get("exclude") || "";
  // **The card's open-nonce** (`?open=`): every row of one open of the For You card
  // carries the same short token, so the shared deal memory is per open and a second
  // open re-deals instead of echoing the first.
  const open = params.get("open") || "";

  try {
    const kind = parsed.def.entry?.kind || "";
    // A watchlist row and a custom row are the two places watched titles live, so they
    // are served whole; every other row drops them.
    const keepWatched = kind === "watchlist" || kind === "custom";
    const metas = withoutWatched(
      parsed.shuffle
        ? await catalogShuffle(parsed.type, parsed.def, parsed.shuffle, { adult, language, sort })
        : await catalogMetas(parsed.type, parsed.def, parsed.skip, { adult, language, sort, exclude, open, count: Number(params.get("count")) || 0 }),
      keepWatched,
    );
    // Better posters first (it may replace `poster`), then the chosen content
    // source (which owns the poster when it is TVDB), then extra metadata.
    await applyPosters(metas);
    await applyContentSource(metas);
    await enrichRatings(metas);
    // A shuffle is never cached: the whole point is that the same URL answers
    // with a different draw, so a copy in the browser would freeze the row.
    //
    // The watchlist and the calendar's rows are not cached either, and that is a
    // bug fix rather than a nicety: they are *your state*, and a 15-minute copy is
    // what made "unpinning a title does not remove it" — the browser kept serving
    // the row as it was before the unpin.
    //
    // A **For You** row is rebuilt from your own titles on every request, so it is
    // uncacheable for the same reason: a 15-minute copy is what froze the card's wall
    // on the four picks the app happened to draw first.
    const stateful = ["watchlist", "custom", "recommend"].includes(parsed.def.entry?.kind);
    json(res, 200, { metas }, parsed.shuffle || stateful ? 0 : 900);
  } catch (err) {
    console.error(`[addon] catalog ${parsed.type}/${parsed.def.id} failed:`, err.message);
    json(res, 200, { metas: [] });
  }
  return true;
}
