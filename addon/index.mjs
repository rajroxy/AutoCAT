/**
 * AutoCAT Collections — a Stremio/AutoCAT catalog addon.
 *
 * Publishes one catalog row per catalog that lives inside each AutoCAT card: a
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
import { cleanScope, currentScope, rescope, withScope } from "./scope.mjs";
import { askAI, askAbout, askTags, verifyAI, aiModels, aiProviderName, aiState } from "./ai.mjs";
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
// **The Activity screen's own read** — the watchlist store, read as a timeline (see `activity`).
import { activity as watchlistActivity } from "./watchlist.mjs";
// **What has left and what has not arrived** — the dates the Updates card's two rows imply,
// written down, and the two gates that act on them (see `addon/lineup.mjs`).
import { cardKeyOfRow, hideGone, hideNotYet, hideOffShelf, isLeaving, joinedOn, keyOf, leavingDay, note as noteLineup, onShelf, payload as lineupPayload, withDates } from "./lineup.mjs";
// **The shelf** — half of TMDB is the app, and the month's own dice pick what turns over
// (see `addon/shelf.mjs`). The two Updates rows are drawn with these, and nothing else is.
import { SHELF_PAGES, SHELF_TURN, dayFor, monthEnd, monthNext, monthOf, monthStart, onShelfCoin, pagesFor, pick, shiftDay } from "./shelf.mjs";
import { end as partyEnd, join as partyJoin, leave as partyLeave, note as partyNote, start as partyStart, state as partyState } from "./party.mjs";
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
  keys as customKeys,
  add as customAdd,
  remove as customRemove,
  metasFor as customMetas,
} from "./customrows.mjs";
import { catalogSpecs, activeRegion, catalogDefs, CATALOG_ID_PREFIX, findCatalog, primeForYouSeeds, primeRegionProviders, primeSpecialistCounts, clearCaches, isOttSort, providerListsReady } from "./catalogs.mjs";
import { activeCountry, activeContentSource, activeLanguage, getSettings, updateSettings, publicSettings, tmdbKey, providerKeys } from "./settings.mjs";
import { enrichRatings, ratingsState, titleRatings, verifyProvider } from "./providers.mjs";
import { pushRating, pushWatch } from "./trackers.mjs";
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
import { authConfigured, authProviders, cleanProfile, clearCookie, finish, forgetLocal, localAccounts, localAccountFor, readSession, redirectUri, sessionCookie, signInLocal, signOut, startUrl, takeAdoption, ensureDefaultAccount } from "./auth.mjs";
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

/**
 * **The two rows that carry a date, and how far past their own length to read for them.**
 *
 * `Leaving Soon` and `Arriving Soon` are the only rows whose membership is *gated* after TMDB
 * answers: a title whose recorded departure has come is dropped from every row, and one you
 * have already watched is dropped from a row that is not your own list. So the row that asked
 * for its fifty came back with forty-seven — the shelf grew shorter as the days passed, which is
 * exactly the "leaving 50 and arriving 50" the owner asked for going soft. The rows are read
 * `LINEUP_OVER` titles deep now and cut back to their own length after the gates: the same window,
 * the same order, with the titles the gates took replaced by the ones behind them.
 */
const LEAVING_ROW = "Leaving Soon";
const ARRIVING_ROW = "Arriving Soon";
const LINEUP_ROWS = new Set([LEAVING_ROW, ARRIVING_ROW]);
const LINEUP_OVER = 20;


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_FILE = path.join(__dirname, "watchlist.json");

export const ADDON_ID = "community.autocat.collections";
export { CATALOG_ID_PREFIX };

// **How many titles one request hands back — a chunk, never a cap.**
//
// This number used to be the *only* window a row was read through, so a card looked
// like it stopped at whatever it said — forty, then two hundred. It is not a ceiling
// on a row: the strip asks again from `skip` the moment you scroll near the end, and
// it keeps asking until TMDB itself has nothing left to hand over. The number is only
// how much arrives in one reply, so the first screen paints fast. There is no total.
const ROW_CHUNK = 200;

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
const SEARCH_COUNTRIES = [["all", "All countries"], ...countryChoices()];
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
 * **Every country there is, with the ones that have content first.**
 *
 * The row used to be `countryVocab()` alone — the countries the Countries card has a
 * row for, which is a **content floor**: eighty names, and the other hundred and
 * seventy were not offered at all. That is a cap, and a filter that cannot name a
 * country is a filter that cannot be used for it. The names that are already familiar
 * still lead (only where they really have titles), and every other country TMDB
 * publishes follows them, so nothing is out of reach and nothing is invented.
 */
function countryChoices() {
  const names = new Map(COUNTRIES.map(([name, code]) => [code, name]));
  const seen = new Set();
  const out = [];
  // **Exactly the countries the Continental card publishes.** The row used to be this list
  // plus every other country TMDB knows (215 names, most of them with nothing behind them);
  // the continents card is the app's own answer to "which countries are there", so the
  // filter and the region picker read the same list it draws its rows from.
  for (const [, codes] of continentsWithContent()) {
    for (const code of codes || []) {
      if (!code || seen.has(code) || REMOVED_COUNTRY_CODES.has(code)) continue;
      seen.add(code);
      out.push([code, names.get(code) || code]);
    }
  }
  return out;
}

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
  // **Back to 1900, not 1950.** The row used to stop at 1950, so half of cinema had no
  // chip at all. Films exist back to the 1870s; 1900 is the floor TMDB's own data is
  // dense enough at to give a row for, and an older year is still accepted by hand
  // (`period=1911` works, it is simply not offered as a chip).
  for (let y = thisYear; y >= 1900; y -= 1) years.push([String(y), String(y)]);
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
    name: s.profile || "AutoCAT Collections",
    description:
      "Curated AutoCAT collection rows — on the board, spotlight, genres, decades, countries, runtimes, moods, themes, OTT charts and your watchlist. One cover per card, live titles from TMDB.",
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
            .map((d) => ({ id: d.id, name: d.name, kind: d.entry?.kind || "", state: d.entry?.state || "", row: d.entry?.row || "", divider: Boolean(d.entry?.divider), offcard: Boolean(d.entry?.offcard) })),
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
    // `wide` is **four cards long** — the card spans four of its neighbours in the grid and
    // holds four poster cards, so what is coming reads as a row of its own at the foot of the
    // page instead of as one card by itself (see the Upcoming card in `scripts/collections.mjs`).
    const wide = Boolean(c.wide);
    return { key: c.key, title: label("movie"), divider: Boolean(c.divider), hidden, spotlight, wide, movie: row("movie"), series: row("series") };
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
  // **It is a row of the catalogue, so the shelf holds on it too** — half of TMDB is not in the app
  // (`hideOffShelf`), and a title the Updates card has taken out is out (`hideGone`). The wall on the
  // title page used to be the one list that still handed back the other half of the catalogue, which
  // made "half of TMDB is out" true of every row but that one.
  more.splice(0, more.length, ...withDates(hideOffShelf(hideGone(more))));
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
  // **`total` is the whole list, not the page.** The head on a credits, studio or
  // network screen used to count what had been *loaded* — twenty — so it read as a cap
  // on a list that really holds hundreds. The caller prints `total`.
  const finish = async (metas, more = false, total = 0) => {
    const list = stripAdult(metas.filter(Boolean), adult);
    try {
      await applyPosters(list);
      await applyContentSource(list);
      await enrichRatings(list);
    } catch {
      /* artwork and ratings are extras — the list itself still stands */
    }
    return { metas: list, more, total: Number(total) || list.length };
  };

  if (kind === "person") {
    const data = await get(`/person/${first}/combined_credits`, base);
    const wanted = [...(data.cast || []), ...(data.crew || [])].filter((c) =>
      media === "movie" ? c.media_type === "movie" : c.media_type === "tv",
    );
    const rows = dedupe(wanted).map((c) => toMeta(c, media));
    return finish(rows, false, rows.length);
  }

  if (kind === "collection") {
    const data = await get(`/collection/${first}`, { language });
    const parts = [...(data.parts || [])].sort((a, b) => String(a.release_date || "").localeCompare(String(b.release_date || "")));
    const parts2 = parts.map((p) => toMeta(p, "movie"));
    return finish(parts2, false, parts2.length);
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
  return finish((data.results || []).map((r) => toMeta(r, media)), wanted < totalPages, data.total_results);
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
    pool = await episodeMetas(media, specs[0].episodes, language, Boolean(opts.adult), opts.sort);
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
    await deepen(entry, Math.max(count * 8, ROW_CHUNK * 4));
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

/**
 * The five orders, read off a show's own record.
 *
 * An episode bucket is built from a cached pool rather than from a TMDB query, so the Explore
 * page's dropdown **re-orders the bucket** instead of re-reading it: the same titles, in the
 * order asked for (`latest` and `newest` are the same date order here — a bucket of shows has
 * no release calendar to be ahead of).
 */
const EPISODE_ORDERS = {
  latest: (a, b) => String(b.first_air_date || "").localeCompare(String(a.first_air_date || "")),
  newest: (a, b) => String(b.first_air_date || "").localeCompare(String(a.first_air_date || "")),
  trending: (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  popular: (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  top_rated: (a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0),
};
const BY_POPULARITY = (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0);

/** One episode bucket: `{ min, max }` — every show whose count falls inside it. */
async function episodeMetas(media, bucket, language = activeLanguage(), adult = false, sort = "") {
  const { min = 1, max = Infinity } = bucket || {};
  const shows = await episodeCandidates(media, language);
  return shows
    .filter((d) => d.number_of_episodes >= min && d.number_of_episodes <= max)
    .filter((d) => adult || !d.adult)
    .sort(EPISODE_ORDERS[sort] || BY_POPULARITY)
    .map((d) => toMeta(d, media))
    .filter(Boolean);
}

async function episodesMetas(media, bucket, skip, language, adult, size = ROW_CHUNK) {
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

/**
 * **The Updates card's two rows: the month's turn on the shelf.**
 *
 * The card is not a reading of the world's calendar any more. The owner's feature is a *service's*
 * shelf (`addon/shelf.mjs`): **half of TMDB is in the app**, and every month fifty titles leave it
 * and fifty arrive, **at random**, with no connection to what the world is releasing —
 * *"unn half me 50 titles leave honge per month and 50 titles aayenge per month randomly aur koi
 * world upcoming ya newly released se koi connection nahi sab random hoga"*. Both rows are built
 * here, out of the same month's dice:
 *
 *   - **Arriving Soon** — the fifty the month brings in. They are drawn from the half that is *not*
 *     in the app (a title can arrive once), every one of them is a title the world has already
 *     released (`<release>.lte` today, so the row can never show something unreleased however random
 *     the draw — the complaint four earlier shapes of this row answered the hard way), and each one
 *     wears **the day it joins the app** — *today* or a day still to come, in this month or the next,
 *     so the row reads like a service's own announcement (`Arrives 20 Oct`, `Arrives today`) and a title is in
 *     the app from that day on (`New 20 Oct` on its poster afterwards).
 *   - **Leaving Soon** — the fifty the month takes out, drawn from the half that *is* in the app,
 *     each wearing the day it goes. A title named here is out of the app **on its own day**
 *     (`isLeaving`) — the warning reads for weeks before it happens, and on the day it comes the
 *     title goes from the cards, the search and the filters, which is the owner's rule:
 *     *"leaving soon titles will remove from app cards, search, filters, etc"*.
 *
 * **The pond is TMDB; the draw is the month.** Two pages of TMDB's popularity order and eight
 * seeded-random ones inside the first sixty (`pagesFor`) are what the fifty are fished out of. No
 * page carries a release-date window, a "trending" flag or a service's schedule — popularity is
 * there only so the pond holds titles with names rather than deep-cut noise — and the fifty are a
 * seeded shuffle of it (`draw`), keyed on the month: every read inside October answers with the
 * same fifty, November answers with a different fifty, and a restart or a second machine answers
 * the same. `Math.random` would re-deal the card on every request.
 *
 * **One draw per row, per media type, per month, and the same fifty on every read inside it.** The
 * month's answer is built once and kept — a popularity order drifting under the pool must not
 * re-deal the card between two reads — and the store keeps the *days* (`noteLineup`), so a title
 * that has been named keeps the day it was named however often the card is opened.
 *
 * **Both rows are a schedule that runs forward from today over two months.** An arrival day is today
 * or a day still to come (a service announces what is joining it), a leaving day is today or a day
 * still to come before it goes, and the row holds **this month's fifty and next month's fifty** —
 * the owner's *"only 20 oct nahi, aage ka 1 month yani october month then november month aise last
 */
const shelfDraws = new Map();

/** The day `n` days from now, the way TMDB takes a date. */
const dayIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/**
 * **How many months of the schedule a row holds: this one, and the one after it.**
 *
 * A turn is fifty titles a month and the month is the unit (`addon/shelf.mjs`), but a *row* is the
 * schedule a service publishes, and a schedule that ended with the calendar month ran out
 * mid-month — the owner's word for the window is *"only 20 oct nahi, aage ka 1 month yani october
 * month then november month aise last tak"*. So a row holds this month's fifty and next month's
 * fifty, soonest first: the day this month ends, what was next month's turn is this month's and the
 * row already holds the month beyond it.
 */
const SHELF_AHEAD = 1;

/**
 * **One month's turn, once per process.** The exclusions a turn is built with are fixed by the month,
 * the row and the media type (`shelfMonth` below), so the same month is the same fifty whoever asks
 * for it and in whatever order — which is what lets the Leaving row's own draw *exclude the arriving
 * row's fifty* without the two rows having to be read in one particular order.
 */
const turnCache = new Map();

/**
 * **One month's fifty for one row** — the pond its draw reads, the draw itself, and the day each
 * title was given.
 *
 * `excluded` is how the two months of one row stay apart **without asking the store**: the next
 * month's draw may not name a title this month's draw already named, so the row answers the same way
 * in any process, over any store, and in whatever order its two months are read. (Asking the live
 * store instead is the trap this file has already fallen into once: a read of one row wrote its
 * arrivals down, which handed eleven of them to the other row and shrank the pond for the next
 * process — measured, both.)
 */
async function monthTurn(rowName, media, language, month, opts = {}) {
  const cacheKey = `${month}:${rowName}:${media}:${language || ""}`;
  const cached = turnCache.get(cacheKey);
  if (cached) return cached;
  const leaving = rowName === LEAVING_ROW;
  const salt = `${media}:${leaving ? "out" : "in"}`;
  const startIso = monthStart(month);
  const field = media === "movie" ? "primary_release_date" : "first_air_date";
  const excluded = opts.excluded instanceof Set ? opts.excluded : new Set();

  // **The shelf as *that* month found it.** The coin, plus every title an earlier month brought in —
  // and, for the month after this one, this month's own fifty too: they all land before it begins.
  // This one predicate decides both rows (`leaving ? before : !before`), and it is a snapshot rather
  // than a live question, because a read of either row writes the arrivals down (`noteLineup`).
  const before = (m) => {
    const k = keyOf(m);
    if (onShelfCoin(k)) return true;
    const joined = joinedOn(m);
    return Boolean(joined) && joined < startIso;
  };
  // **A title an earlier month named as leaving is gone and never comes back to either pond**, and
  // this is the whole of the exclusion: the *recorded day*, not "has the row named it yet". Excluding
  // what this month's own row named looked equivalent and was not — the month's fifty left the pond
  // the moment they were written, the shuffle over what was left answered with fifty *different*
  // titles, and every fresh process named fifty more (measured: the store reached 400 leaving titles
  // in eight runs, and a second server's row came back 25 long where the first server's came back 50).
  const leftBefore = (m) => {
    const at = leavingDay(m);
    return Boolean(at) && at < startIso;
  };
  const candidates = () =>
    pond.filter((m) => (leaving ? before(m) && !leftBefore(m) : !before(m)) && !excluded.has(keyOf(m)));

  // **The cutoff is the month's own.** "Nothing the world has not released can arrive" is the owner's
  // rule, and the row is the month's turn — so a title released *inside* the month it is joining is
  // not a candidate either (the world's new releases are not this feature's business: *"koi world
  // upcoming ya newly released se koi connection nahi"*). Reading it as "released by today" instead
  // made the pool depend on the clock: a server a month ahead asked TMDB for `<date>.lte` a month
  // later, pulled in a month of new titles, and the pool it drew from was not the one the app had
  // drawn from. The finding is the **first day of the month being drawn**, which is the same day
  // whenever and wherever that month's turn is built.
  const windowEnd = !leaving ? shiftDay(startIso, -1) : "";

  const seen = new Set();
  const pond = [];
  // **The pages of one month's draw are read at once, and put in the pond in page order.** A cold
  // read is ten TMDB pages a turn and a row is two turns (this month and the next) for each media
  // type — one page after another is eighty round trips before a card can be drawn, so they go out
  // together (`Promise.all`) and the cache behind `get` (`addon/tmdb.mjs`) keeps the repeats free.
  //
  // **The *order* they land in must not matter.** Appending each answer as it arrives made the pond's
  // order a race between ten HTTP responses, and `draw` is a Fisher–Yates shuffle — an order-sensitive
  // one — so two processes reading the same pages drew **different fifties**: measured, a restart in
  // the same month answered with 43 of its 100 titles changed, and a server a month ahead shared only
  // 33 of the 52 titles both schedules contained. Collected first, appended in page order, the pond is
  // the same list in every process on every machine, and so is the fifty.
  const readPages = async (pages) => {
    const answers = await Promise.all(
      pages.map((page) =>
        get(`/discover/${tmdbPath(media)}`, {
          sort_by: "popularity.desc",
          "vote_count.gte": 20,
          page,
          // Nothing the world has not released can arrive (`windowEnd` above). The leaving row needs
          // no window at all: it only ever holds titles the app has.
          ...(leaving ? {} : { [`${field}.lte`]: windowEnd }),
          language,
        }).catch(() => null),
      ),
    );
    for (const res of answers) {
      for (const item of res?.results || []) {
        const meta = toMeta(item, media);
        if (!meta || seen.has(meta.id)) continue;
        seen.add(meta.id);
        pond.push(meta);
      }
    }
  };

  await readPages(pagesFor(month, salt));
  let mine = candidates();
  // **A full fifty is the promise the rows make** (`SHELF_TURN`), so when a month's pages have already
  // given away most of their titles to earlier months the pond is widened — the *same* month's dice,
  // more of them (`pagesFor` extends its own seeded list, so the first ten pages are the ones already
  // read and the draw does not change shape).
  if (mine.length < SHELF_TURN) {
    await readPages(pagesFor(month, salt, SHELF_PAGES * 2).slice(SHELF_PAGES));
    mine = candidates();
  }

  // **The turn is the fifty whose own coin comes out best for this month's row** — see `pick` in
  // `addon/shelf.mjs` for why this is a coin and not a shuffle: a shuffled pool changed fifty titles
  // when the order it was written in changed, and the pool does change (ten HTTP answers, a store
  // that grows as rows are read).
  const drawn = pick(mine, SHELF_TURN, `${month}:${rowName}:${media}`, keyOf);
  // **The days**: the month we are inside runs from today — a schedule has nothing on it that has
  // already gone by — and a month still to come runs from its own first day, because every day of it
  // is ahead of us. Both stay inside the month its turn belongs to, which is what lets the store's own
  // day say whether a title was named before the month a draw is being built for (`before`/
  // `leftBefore`).
  const from = opts.lead ? dayIn(0) : startIso;
  const to = monthEnd(month);
  const stamped = drawn.map((m) => ({
    ...m,
    shelfOn: dayFor(`${month}:${rowName}:${media}:${keyOf(m)}`, from, to),
  }));
  // **The row opens on today's own arrival**, rather than on the luck of the spread. Only the month we
  // are inside has a "today" to give a title; a month still to come has none.
  if (!leaving && opts.lead && stamped.length) stamped[0] = { ...stamped[0], shelfOn: dayIn(0) };
  turnCache.set(cacheKey, stamped);
  if (turnCache.size > 64) turnCache.delete(turnCache.keys().next().value);
  return stamped;
}

/**
 * **The arriving fifty of a run of months** — this month's, then the next month's minus the titles
 * this month's named, exactly as the Arriving row itself is built.
 *
 * The Leaving row reads this as its own exclusion set (see `shelfMonth`): one *schedule*, so a title
 * the app is still bringing in cannot be named as leaving in the same window — a service does not
 * announce a departure for something it has not carried yet, and the two rows of the Updates card
 * would otherwise be able to share a title (measured: six films arrived in October on the Arriving
 * row and left in November on the Leaving row, with nothing on either row saying so).
 */
async function arrivingTurns(media, language, months) {
  const named = new Set();
  const out = [];
  for (const [i, at] of months.entries()) {
    const turn = await monthTurn(ARRIVING_ROW, media, language, at, { lead: i === 0, excluded: named });
    for (const m of turn) named.add(keyOf(m));
    out.push(turn);
  }
  return out;
}

/**
 * **The row: this month's turn and next month's, as one schedule.**
 *
 * Built once per process and kept (`shelfDraws`) — a popularity order drifting under the pool must not
 * re-deal the card between two reads — and the store keeps the *days* (`noteLineup`), so a title that
 * has been named keeps the day it was named however often the card is opened.
 *
 * **The two months are drawn in order**, this one first and the one after it minus the titles this one
 * named, so the answer does not depend on which month a process happens to read first, and the next
 * month's turn is the same fifty when it becomes this month's.
 */
async function shelfMonth(rowName, media, language) {
  const month = monthOf();
  const key = `${month}:${rowName}:${media}:${language || ""}`;
  const hit = shelfDraws.get(key);
  if (hit) return hit;

  const months = [month];
  for (let i = 0; i < SHELF_AHEAD; i++) months.push(monthNext(months[months.length - 1]));

  // **The arriving fifty of both months are the Leaving row's exclusion list.** One schedule: what
  // is coming in over these two months cannot be named as going out in them.
  const arriving = rowName === LEAVING_ROW ? await arrivingTurns(media, language, months) : [];
  const arriveKeys = new Set(arriving.flat().map(keyOf));

  const out = [];
  const named = new Set();
  for (const [i, at] of months.entries()) {
    const excluded = rowName === LEAVING_ROW ? new Set([...arriveKeys, ...named]) : named;
    const turn = await monthTurn(rowName, media, language, at, { lead: i === 0, excluded });
    for (const m of turn) named.add(keyOf(m));
    out.push(...turn);
  }

  // **The order is the order of the tags the row is about to wear.** The day that counts is the one
  // the app has already said — the store's, which is the *first* word (`noteLineup` keeps it) — and
  // only a title the store has never dated falls back to the day this draw gave it. Soonest first on
  // both rows: what joins the app next is the news on the Arriving row, what goes next is the warning
  // on the Leaving row, and the two months of a row read as one schedule.
  const dayOf = (m) => joinedOn(m) || m.shelfOn;
  out.sort((a, b) => dayOf(a).localeCompare(dayOf(b)));

  shelfDraws.set(key, out);
  if (shelfDraws.size > 24) shelfDraws.delete(shelfDraws.keys().next().value);
  return out;
}

/** **One of the two shelf rows, paged.** `skip` walks the month's fifty and then there is no more. */
async function shelfMetas(rowName, media, skip, window, language, adult = false) {
  const row = await shelfMonth(rowName, media, language);
  return stripAdult(row, adult).slice(skip, skip + window);
}

export async function catalogMetas(media, def, skip, opts = {}) {
  // **How big a window one request hands back.** The default is one chunk, but a
  // caller filling out a whole letter (Explore's alphabet rail) can ask for several
  // chunks in one round trip. **There is no clamp here any more** — the `Math.min(200,
  // …)` was a second ceiling hiding inside the first, and a caller that asks for more
  // titles now simply gets them.
  const window = Math.max(1, Number(opts.count) || ROW_CHUNK);
  const specs = def.entry ? await catalogSpecs(def.entry, media, opts) : [];
  // **An Explore page reads a row to its end, whatever its card is called.** A `take` is
  // the size of a *card* — the ◆ Top 10 rows are ten titles on the wall they were published
  // for, and every other capped row was capped for its wall's sake too — so a reader who
  // says it is scrolling the row itself (`deep`, which only the Explore page sets) gets the
  // row without its cap, and "End of catalog." arrives when TMDB has nothing left rather
  // than where the card stopped. Specs are rebuilt per request, so this adjusts this
  // request's copy and nobody else's.
  // **A top-up read is a deep read of the same row.** It wants the row past its card's own
  // length for the same reason Explore does (see the note above), so it lifts the cap and draws
  // the same pool — a second pool for the same titles would only be read twice.
  const lifted = Boolean(opts.deep) || Boolean(opts.over);
  if (lifted) for (const spec of specs) if (spec.take) spec.take = undefined;
  // Key on the catalog's identity *and* its resolved entry — two definitions
  // must never share a pool just because one of them has no id.
  const identity = def.id ?? JSON.stringify(def.entry ?? def);
  const language = opts.language || activeLanguage();
  // See `catalogShuffle`: the sort is part of the pool identity, so switching the
  // OTT dropdown cannot be answered from the other order's pool.
  const key = `${media}:${identity}:${opts.adult ? "a" : "s"}:${language}:${opts.sort || ""}${lifted ? ":deep" : ""}`;

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

  // **The Updates card's two rows — the shelf's own month** (see `shelfMonth`). Not a window over
  // the world's calendar in either direction: fifty titles the app is bringing in, fifty it is
  // taking out, drawn from the month and dated by it.
  if (specs.length === 1 && specs[0].arriving) {
    return shelfMetas(ARRIVING_ROW, media, skip, window, language, Boolean(opts.adult));
  }
  if (specs.length === 1 && specs[0].leaving) {
    return shelfMetas(LEAVING_ROW, media, skip, window, language, Boolean(opts.adult));
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

/* ------------------------------------------------- the wide title artwork */

/**
 * **A title's landscape poster**: the wide picture its name is printed on.
 *
 * The wide tiles are 16:9, so what goes in one has to be landscape, and a *named* wide
 * picture rather than any wide picture: TMDB's own `backdrop_path` — the shot a row
 * arrives with — is whichever still the title was catalogued with, which is why the
 * Upcoming card could show four film stills and no title between them.
 *
 * A title's images are one list (`/{movie|tv}/{id}/images`), and the difference between a
 * still and a title treatment is **the language**: TMDB leaves `iso_639_1` null on a
 * picture with no text in it and fills it in on the ones that carry their own name. So the
 * order here is this app's language first, then any language at all, then the plain wide
 * shot — and an empty answer means the caller keeps what it already has.
 *
 * Cached for a day, because a title's artwork does not move and every draw of the card
 * asks again.
 */
const LANDSCAPE_TTL = 24 * 60 * 60 * 1000;
const landscapeArts = new Map();

async function landscapeArt(media, id, language, scene = false) {
  const key = `${media}:${id}:${language}${scene ? ":scene" : ""}`;
  const hit = landscapeArts.get(key);
  if (hit && hit.expires > Date.now()) return { url: hit.url, kind: hit.kind };

  let url = "";
  let kind = "";
  try {
    const short = String(language || "en").slice(0, 2).toLowerCase();
    const images = await get(`/${tmdbPath(media)}/${id}/images`, {
      include_image_language: `${short},null`,
    });
    // **The best of a list, not the first.** A title can carry twenty wide pictures, and
    // the one a person recognizes is the one other people kept using — TMDB's own vote
    // is the only ordering there is, and width breaks a tie.
    const by = (a, b) => (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0);
    const wide = (images?.backdrops || []).filter((b) => b?.file_path);
    const named = wide.filter((b) => b.iso_639_1);
    // **A scene, or the title's key art.** `scene` is what your own lists ask for — *"user jo
    // dekh raha hoga uske content se scene na daloge"* — and a **scene** is a wide picture with
    // no text on it: TMDB leaves `iso_639_1` null on exactly those, and fills it in on key art,
    // which is a wide poster with the title printed on it. So a scene read must never fall back
    // to the named one; its fallback is the trailer's own frame, which is the content itself.
    const best = scene
      ? [...wide].filter((b) => !b.iso_639_1).sort(by)[0]
      : named.filter((b) => String(b.iso_639_1).toLowerCase() === short).sort(by)[0] ||
        [...named].sort(by)[0] ||
        [...wide].sort(by)[0];
    if (best) {
      url = `${IMG}/w1280${best.file_path}`;
      kind = best.iso_639_1 ? "keyart" : "still";
    }
    // **A wide frame out of the trailer.** Plenty of new titles have no wide picture at all — a
    // slow film from Jakarta has one 2:3 poster the week it opens — and a 2:3 poster in a 16:9
    // slot is either a band cut through it (the black bars the owner reported) or a letterboxed
    // stamp. Almost every one of those titles *does* have a trailer on TMDB, and a trailer's
    // own thumbnail is a 16:9 frame of the actual title: the name is drawn on the tile by the
    // card's own frame, so a still of the thing is the wide picture that fits. It is the last
    // answer, not the first — real key art and real backdrops still win.
    if (!url) {
      const videos = await get(`/${tmdbPath(media)}/${id}/videos`, { language });
      const clips = (videos?.results || []).filter((v) => v?.key && v?.site === "YouTube");
      const clip =
        clips.find((v) => v.type === "Trailer" && String(v.iso_639_1).toLowerCase() === short) ||
        clips.find((v) => v.type === "Trailer") ||
        clips[0];
      if (clip) {
        url = `https://img.youtube.com/vi/${clip.key}/maxresdefault.jpg`;
        kind = "trailer";
      }
    }
  } catch {
    // An old title with no image list, or a blip: no answer, and the card keeps the wide
    // shot the row served it — the tile is never left empty because of this call.
    url = "";
    kind = "";
  }

  landscapeArts.set(key, { url, kind, expires: Date.now() + LANDSCAPE_TTL });
  if (landscapeArts.size > 400) landscapeArts.delete(landscapeArts.keys().next().value);
  return { url, kind };
}

/* --------------------------------------------------------------- the pairing */

/**
 * **What to put on *with* this one.**
 *
 * *Find a pairing* used to hand the question to the assistant, which meant a press that said it
 * would find a pairing opened a text box instead. The pairing is a fact about the catalogue and
 * the catalogue can answer it: TMDB's own two "what else" lists for a title — its
 * **recommendations**, then its **similar** titles — are the neighbours it keeps, so the first
 * few of those are the pairing, each one carrying why it is on the list (how it is rated, and
 * whether it comes from a different year), which is the line the box prints under its name.
 *
 * Cached for half an hour: the list does not move, and the box can be opened twice in a minute.
 */
const PAIR_TTL = 30 * 60 * 1000;
const PAIRS = new Map();

async function pairings(media, id, language) {
  const key = `${media}:${id}:${language}`;
  const hit = PAIRS.get(key);
  if (hit && hit.expires > Date.now()) return hit.list;

  let list = [];
  try {
    const detail = await get(`/${tmdbPath(media)}/${id}`, {
      append_to_response: "recommendations,similar",
      language,
    });
    const seedId = String(detail?.id || id);
    const seedYear = Number(String(detail?.release_date || detail?.first_air_date || "").slice(0, 4)) || 0;
    const seen = new Set([seedId]);
    const out = [];
    const candidates = [...(detail?.recommendations?.results || []), ...(detail?.similar?.results || [])];
    for (const raw of candidates) {
      const meta = toMeta(raw, media);
      const rawId = String(raw?.id || "");
      if (!meta || !rawId || seen.has(rawId)) continue;
      seen.add(rawId);
      const year = Number(String(meta.releaseDate || "").slice(0, 4)) || 0;
      const years = seedYear && year ? year - seedYear : 0;
      meta.pairWhy = [
        meta.imdbRating ? `Rated ${meta.imdbRating}` : "",
        years === 0 ? (year ? `Same year — ${year}` : "") : `${year} · ${Math.abs(years)} year${Math.abs(years) === 1 ? "" : "s"} ${years < 0 ? "earlier" : "later"}`,
      ]
        .filter(Boolean)
        .join(" · ");
      out.push(meta);
    }
    // **The best of the neighbours, not the first four.** Recommendations arrive in TMDB's own
    // order, which is popularity, so the four would be the four most popular every time; the
    // rating is the one ordering that says "worth pairing" rather than "well known".
    out.sort((a, b) => Number(b.imdbRating || 0) - Number(a.imdbRating || 0));
    list = out.slice(0, 4);
  } catch {
    list = [];
  }

  PAIRS.set(key, { list, expires: Date.now() + PAIR_TTL });
  if (PAIRS.size > 200) PAIRS.delete(PAIRS.keys().next().value);
  return list;
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
    countries: countryChoices().map(([code, name]) => ({
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

/**
 * The account block every settings / `/auth/me` answer carries.
 *
 * **`redirects` is why this exists as a function.** A provider sign-in only works when the
 * callback registered with the provider is character-for-character the one this server
 * sends, so the page is handed the exact string to register rather than left to assemble
 * one (and the desktop app pins its port, so that string is stable across launches — see
 * `desktop/main.js`).
 */
const accountPayload = (req, origin) => {
  // **The profile the pane is being drawn for.** The app asks as the profile that is on,
  // so the names it lists are that profile's own accounts — the machine's single account
  // used to answer for both profiles, which is the bug this payload fixes.
  const profile = profileOf(req);
  // **And it has its account before it is asked about one** (see `ensureDefaultAccount`):
  // Adam on the first profile, Eve on the second, so Settings → Profile opens on an account
  // rather than on an empty field.
  ensureDefaultAccount(profile);
  return {
    profile,
    configured: authConfigured(),
    providers: authProviders(),
    redirects: Object.fromEntries(authProviders().map((p) => [p.key, redirectUri(p.key, origin)])),
    accounts: localAccounts(profile),
    local: localAccountFor(req, profile),
    user: readSession(req, profile),
  };
};

/** The profile a request names: `?who=` first, then the POST body's own `who`. */
function profileOf(req) {
  try {
    return cleanProfile(new URL(req.url ?? "/", "http://localhost").searchParams.get("who"));
  } catch {
    return cleanProfile("");
  }
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
 * **The titles you own belong in two places, and this is the rule that keeps them there.**
 *
 * A title you have planned, started or watched appears in the Watchlist card's own row for
 * that state and in a **Custom** row you put it in — and nowhere else: not in another Home
 * card, not in another catalog row, not in search. Search in particular has **no filter to
 * reveal them**: the answer for "show me that film again" is the Watched row, and a search
 * that silently hid titles with no way to ask for them back would be the worse trade.
 *
 * The watchlist and custom rows are kept whole (they *are* the two places), so the
 * filter is applied where a row came from TMDB.
 *
 * A **Library row** counts here too: a title you filed in one of your own rows is off Home
 * and out of Search exactly as a pinned one is, and the row you put it in (and the Library
 * card) is where it lives.
 */
/** The keys inside every one of **your** Library rows — the calendar's own row aside.
 *
 * The calendar's row (`calendar-plans`) is not a Library row: a plan made from the grid is a
 * date you are waiting for, and a title you have planned that way stays where you found it.
 */
function libraryKeys() {
  const out = [];
  for (const [row, keys] of Object.entries(customKeys() || {})) {
    if (row === "calendar-plans") continue;
    if (Array.isArray(keys)) out.push(...keys);
  }
  return out;
}

export function withoutWatched(metas, keep = false) {
  if (keep) return metas;
  const watched = [...watchedKeys(), ...libraryKeys()];
  if (!watched.length) return metas;
  const set = new Set(watched);
  const keyOf = (m) => `${m?.type === "series" ? "series" : "movie"}:${String(m?.id || "")}`;
  return metas.filter((m) => !set.has(keyOf(m)));
}

function customPayload() {
  // `rows` carries each row's name and order as well as its count: the title page draws
  // one "Add to …" button per row, so the names are needed on every read, not only in the
  // settings pane. (`rows` used to be counts alone, which is a subset of this.)
  return { rows: customRowList(), counts: customCounts(), keys: customKeys(), items: customItems() };
}

/**
 * Handle an addon request. Returns true when the request was answered, false
 * when it is not an addon route (so the caller can fall through to static
 * file serving).
 */
/**
 * **Which profile's watchlist and Library this request is about.**
 *
 * The app sends `who=<profile id>` on every request (see `get`/`post` in the UI), so the
 * server keeps one watchlist and one Library **per profile** instead of one per machine.
 * A caller that sends no `who` — Stremio reading the addon, a script, the test suite —
 * keeps the plain files and sees exactly what it saw before.
 */
/**
 * **Who is watching rides with the request.**
 *
 * Every profile-owned store — settings and keys, the Library, the watchlist, the saved
 * sites, the preferences, the resolver — is a file per profile, and the file is derived
 * from `who` **when it is used**, inside this scope, not from a variable set at the top
 * of the handler and read after an `await` (see `scope.mjs` for why that was wrong).
 *
 * The two process-wide caches need the same treatment, because they hold *answers built
 * with a profile's key and add-ons*: the TMDB key is re-pointed at this profile before
 * anything is fetched, and a move between two profiles drops both caches rather than
 * handing one person the other's streams. A request that carries no `who` at all is an
 * asset or a client outside the app, so it neither re-points anything nor clears
 * anything — rebuilding every cached answer each time a font loads would be a cost with
 * nothing to show for it.
 */
let lastScoped = "";
export async function handleAddon(req, res, pathname, origin) {
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const who = cleanScope(params.get("who"));
  // **One account is one app.** A profile can hold up to five local accounts, and the one
  // in use rides on every request (`as=`), so the scope is the pair: `you-local-a1b2`.
  // Everything a profile owns — keys and add-ons, the Library, the watchlist, the saved
  // sites, the preferences, the resolver — is filed per *pair*, so two accounts on one
  // profile share nothing at all. An `as` that names no account of this profile is
  // ignored rather than trusted.
  const asked = cleanScope(params.get("as"));
  const scope = scopeFrom(who, asked);
  // The account carried over from before accounts existed adopts the files that were there.
  if (asked && scope !== who && takeAdoption(asked)) adoptScopeFiles(who, asked);
  // **Which mode the settings belong to.** VOD and IPTV keep their own settings (`mode=`),
  // so a playlist added in IPTV is not a playlist in the films app — while the Library and
  // the watchlist stay one history, which is why they are not filed by mode.
  const mode = cleanScope(params.get("mode")).toLowerCase();
  return withScope(scope, async () => {
    try { setKey(tmdbKey()); } catch { /* the TMDB module owns its own key */ }
    if (who !== lastScoped) {
      lastScoped = who;
      if (who) {
        clearStreamCache();
        clearTmdbCache();
      }
    }
    return serveAddon(req, res, pathname, origin);
  }, mode);
}

/**
 * **A POST may name the profile in its body.** The URL carries it too, so this is a
 * no-op for the app — but a caller that sends only a body still lands in the right
 * profile, and a move between two profiles drops the caches built for the other one
 * rather than answering with them.
 */
/**
 * The scope a request names: the profile, plus the account it chose when there is one.
 *
 * `you` or `you-local-a1b2`. An `as` that names no account of that profile is ignored
 * rather than trusted, so a hand-written request cannot file work under an account that
 * does not exist (or under another profile's).
 */
const scopeFrom = (who, as) => {
  const profile = cleanProfile(who);
  const wanted = cleanScope(as);
  return wanted && localAccounts(profile).some((a) => a.id === wanted) ? `${profile}-${wanted}` : profile;
};

/**
 * **The account carried over from before accounts existed takes the app with it.**
 *
 * Every store a profile owns is a file per scope (`settings.you.json`,
 * `watchlist.you.json`, …). The account that was signed in on this machine when the split
 * arrived adopts them: each `*.<profile>.json` is copied to `*.<profile>-<account>.json`
 * **once**, so signing in as that account opens the app that was there rather than an empty
 * one. A second account is deliberately left empty — separate is the point.
 */
function adoptScopeFiles(profile, account) {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^(.+)\.([a-z0-9_-]{1,32})\.json$/i);
      if (!m) continue;
      const [, base, scope] = m;
      if (scope !== profile) continue;
      const to = path.join(dir, `${base}.${profile}-${account}.json`);
      if (fs.existsSync(to)) continue;
      fs.copyFileSync(path.join(dir, name), to);
    }
  } catch {
    // Read-only folder, or nothing to copy: the account simply starts empty.
  }
}

const scopeStores = (who) => {
  const next = cleanScope(who);
  if (!next || next === lastScoped) return;
  lastScoped = next;
  rescope(next);
  try { setKey(tmdbKey()); } catch { /* the TMDB module owns its own key */ }
  clearStreamCache();
  clearTmdbCache();
};

async function serveAddon(req, res, pathname, origin) {
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
        // **A pasted key is trimmed on the way in**, so a trailing space from the
        // clipboard cannot be the reason a working key is refused (see `verifyAI`).
        if (patch?.ai?.keys && typeof patch.ai.keys === "object") {
          for (const name of Object.keys(patch.ai.keys)) patch.ai.keys[name] = String(patch.ai.keys[name] || "").trim();
        }
        updateSettings(patch);
        setKey(tmdbKey());
        // **An add-on you just added has to play now.** Every cached stream answer was
        // read from the old add-on list, so the played title would keep saying "nothing
        // is configured to play anything" for up to five minutes after pasting one.
        if (patch && ("sources" in patch || "enrich" in patch)) clearStreamCache();
        // **A new country is a new set of regional rows.** The set of services TMDB lists
        // for the region is read before the app draws the card, so the rows it shows are
        // rows that resolve rather than rows that open empty.
        if (patch && "country" in patch) await primeRegionProviders().catch(() => {});
        // **An enrichment switch has to change what you see.** Rows, posters and
        // ratings are built from TMDB answers held in memory, so toggling enrichment
        // (or picking a different poster service / provider) rewrites nothing until
        // those answers are dropped — which is exactly "enrichment does nothing".
        if (patch && ("enrich" in patch || "posters" in patch || "providers" in patch || "ratings" in patch)) clearTmdbCache();
        json(res, 200, { ...publicSettings(), options: appOptions(), dns: publicDns(), customSites: publicSites(), prefs: getPrefs(), account: accountPayload(req, origin) });
      } catch (err) {
        json(res, 400, { error: String(err?.message || err) });
      }
      return true;
    }
    json(res, 200, { ...publicSettings(), options: appOptions(), dns: publicDns(), customSites: publicSites(), prefs: getPrefs(), account: accountPayload(req, origin), customKeys: customKeys() });
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
        // **The calendar is the app's calendar, so it holds the app's half.** A month of TMDB
        // releases is a list of titles like any row (`/calendar/…` is what the Calendar screen and
        // the app's own "today" read ask for), and the shelf's two rules hold on it exactly as they
        // do on a card: half of the catalogue is not in the app at all (`hideOffShelf`), and a title
        // the Leaving Soon row has named is gone from it (`hideGone` — the owner's rule is *"remove
        // from app cards, search, filters, etc"*). Nothing about a date makes a title the app does
        // not carry worth showing on a grid of what is coming.
        data.metas = withDates(hideOffShelf(hideGone(data.metas)));
        // **No poster service in the calendar.** A calendar tile is a release date and a
        // face; the rating artwork BetterPosters bakes in has no date on it and put a
        // second, unrelated caption over the tile.
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

  // **A rating goes out to the trackers, and the answer says which ones took it.** The grid
  // on a title page posts here; the rating itself is kept by the app either way, so this is
  // a copy being delivered rather than a value being stored (see `addon/trackers.mjs`).
  if (pathname === "/tracking/rate") {
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
      const { item, rating } = await readBody(req);
      json(res, 200, await pushRating(item, Number(rating) || 0));
    } catch (err) {
      json(res, 400, { ok: false, text: String(err?.message || err) });
    }
    return true;
  }

  // **What you are watching, going out.** The player marks a title Watching at the start and
  // Watched at the end; those two marks are handed to the connected trackers here (see
  // `addon/trackers.mjs`). A service with no token answers with that and nothing else.
  if (pathname === "/tracking/watch") {
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
      const { item, watched } = await readBody(req);
      json(res, 200, await pushWatch(item, watched));
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
    json(res, 200, { ok: true, ...accountPayload(req, origin) });
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
      const { user, sessionId, accounts } = signInLocal(body);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": sessionCookie(sessionId, secureOrigin(origin)),
      });
      res.end(JSON.stringify({ ok: true, user, accounts, local: user }));
    } catch (err) {
      json(res, 400, { ok: false, error: String(err?.message || err) });
    }
    return true;
  }

  // **Forget it.** Signing out ends the session; this takes the account off the machine
  // as well, which is the only way to stop the card offering the name back.
  if (pathname === "/auth/local/forget" && req.method === "POST") {
    // One account, named in the body; no body forgets every account this machine holds.
    let wanted = "";
    try {
      wanted = String((await readBody(req)).id || "");
    } catch {
      /* an empty body means "all of them", the shape this route always had */
    }
    forgetLocal(wanted);
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
      customKeys: customKeys(),
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
        scopeStores(scopeFrom(body.who, body.as));
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

  // **The lineup: what has left, and what has not landed yet.** The store behind the dates on
  // the cards, readable on its own so the screen that shows it (and the checks) do not have to
  // infer it from a row. Nothing here decides what a row shows — see `addon/lineup.mjs`.
  if (pathname === "/lineup.json" || pathname === "/lineup") {
    json(res, 200, { ok: true, ...lineupPayload() });
    return true;
  }

  // **Activity: this profile's own list, read as a timeline.** One line per pinned title,
  // newest first, straight out of the watchlist store (see `activity` in `watchlist.mjs`) --
  // the screen is a *view* of what the app already keeps, not a second log to keep in step.
  if (pathname === "/activity.json" || pathname === "/activity") {
    // The scope is already set for this request (`handleAddon` did that before routing), so the
    // store under `activity` is this profile's own; the only query this route reads is the cap.
    const want = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("limit"));
    json(res, 200, { ok: true, events: watchlistActivity(want || 80) });
    return true;
  }

/**
 * **Who can watch this with you.**
 *
 * A watch party pairs *people*, so this read answers with the **accounts on this machine** —
 * which is what a profile is here — and what each of them has to do with *this* title. That
 * second part comes from their own watchlist, read for their profile alone: `rescope` moves the
 * work in hand onto another account's file (`AsyncLocalStorage`, so no other request can see it)
 * and the store asks for its file at the moment it reads it.
 *
 * Nothing is invented. An account with nothing to do with the title says exactly that, and the
 * room's code is what turns a person into a pairing.
 */
function watchersFor(media, id, { profile = "", as = "" } = {}) {
  const key = `${media === "series" ? "series" : "movie"}:${String(id || "").replace(/^tmdb:/, "")}`;
  let accounts = [];
  try {
    accounts = localAccounts(cleanProfile(profile)) || [];
  } catch {
    accounts = [];
  }
  const here = currentScope();
  const out = [];
  for (const account of accounts) {
    const who = String(account?.id || "");
    if (!who) continue;
    let why = "On this machine — start the room and they join with its code.";
    if (who === as) {
      why = "The profile you are on — a party needs a second person, so this one is already in.";
    } else {
      try {
        rescope(who);
        const hit = watchlistList().find((it) => `${it?.type === "movie" ? "movie" : "series"}:${String(it?.id || "").replace(/^tmdb:/, "")}` === key);
        if (hit) why = `${STATE_LABEL[hit.state] || "In their list"} — they already have this one.`;
      } catch {
        /* a profile with no store yet has nothing to say about the title */
      } finally {
        rescope(here);
      }
    }
    out.push({ id: who, name: account.name || "Someone", why, you: who === as });
  }
  return out;
}

  // **Watch Along: the party around a title, and the talk about it.** A room is one code —
  // started for a title, joined by whoever is watching too — and the notes under it are what
  // the people watching said. Both are held in `party.json`, one file for the machine, because
  // a code nobody else can find is not a party (see `addon/party.mjs`). The names on a note and
  // on a join are read from the **profile's own account list**, never from the body: a request
  // cannot sign its talk with a name it does not hold.
  if (pathname === "/party.json" || pathname === "/party") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return true;
    }
    // The accounts of the profile asking — the people a party on this machine can be with.
    const accountsIn = (profile) => {
      try {
        return localAccounts(cleanProfile(profile)).map((a) => ({ id: a.id, name: a.name }));
      } catch {
        return [];
      }
    };
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const profile = cleanProfile(body.who);
        const as = cleanScope(body.as);
        const mine = accountsIn(profile);
        const name = mine.find((a) => a.id === as)?.name || (as ? "" : "You") || "You";
        const who = as || cleanScope(body.who) || "you";
        const args = { key: body.key, title: body.item, who, name, text: body.text, code: body.code };
        const out = body.action === "start" ? partyStart(args)
          : body.action === "join" ? partyJoin(args)
          : body.action === "leave" ? partyLeave(args)
          : body.action === "end" ? partyEnd(args)
          : body.action === "note" ? partyNote(args)
          : { ok: false, text: `unknown action ${body.action}` };
        json(res, out.ok ? 200 : 400, { ...out, accounts: mine, as });
      } catch (err) {
        json(res, 400, { ok: false, text: String(err?.message || err) });
      }
      return true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const who = cleanScope(url.searchParams.get("who"));
    const found = partyState(url.searchParams.get("key") || "", url.searchParams.get("code") || "");
    json(res, 200, { ...found, accounts: accountsIn(who), as: cleanScope(url.searchParams.get("as")) });
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
        scopeStores(scopeFrom(body.who, body.as));
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
    // **The rows, and what is inside them.** The app filters a title out of Home and Search
    // once it belongs to you — a pin does it, and so does a Library row — and that filter
    // needs the *keys*; the counts alone can only say how many, never which.
    json(res, 200, { ok: true, rows: customRowList(), max: MAX_CUSTOM_ROWS, counts: customCounts(), keys: customKeys(), items: customItems() });
    return true;
  }

  if (pathname.startsWith("/custom-rows/") && req.method === "POST") {
    try {
      const body = await readBody(req);
      scopeStores(scopeFrom(body.who, body.as));
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

  // **The box's suggestions, written for the open** (see `askTags`).
  if (pathname === "/ai/tags" && req.method === "POST") {
    try {
      const body = await readBody(req);
      json(res, 200, await askTags(body.context || {}));
    } catch (err) {
      json(res, 200, { ok: false, tags: [], text: String(err?.message || err) });
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
          : await verifyAI(provider, body.key ? String(body.key) : undefined, body.model ? String(body.model) : "");
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
    // **"All countries" is a filter of its own.** Every other `all` means "no filter on
    // this line", but this one says *the world instead of the region* — and a screen that
    // asks for it has asked for something, so it browses. Without this the chip selected
    // and the grid stayed empty, which is half of "clicking All countries does nothing".
    const browsing = !query && (hasFilters(filters) || params.get("country") === "all");
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
      // **Search drops what has left too.** A title the catalogue has taken off its shelves
      // must not still be findable by name; a title that has not *arrived* stays findable (with
      // its date on the card), because searching for what is coming is how you plan to watch it.
      // **Half the catalogue is not in the app at all**, so a title outside the shelf is not
      // findable by name either (`hideOffShelf`) — the same rule every row reads.
      const kept = withDates(hideOffShelf(hideGone(withoutWatched(stripAdult(metas, adult)))));
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
    // **No add-on channels in the lineup.** A live Stremio add-on publishes its channels
    // as catalogues, and this merged them in behind the user's own playlist — so Live TV
    // showed an add-on's lineup (PenguPlay's, and whatever else declared a live catalog)
    // beside the M3U, and a profile with nothing configured showed somebody else's.
    // Live TV comes from your M3U URL, your file, or your Xtream code: nothing else.
    const lineup = [...(list.channels || [])];
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
  if (pathname === "/refresh.json") {
    // **The app's own refresh, server-side.** Pressing Home or the chosen Movies / Shows plate
    // re-reads every row on the screen; without this the addon answered those re-reads out of
    // its own TMDB cache, so the catalogs and the card posters came back identical and the
    // press looked like it had done nothing. Both caches go — the addon's TMDB answers (`clearTmdbCache` in `tmdb.mjs`) and the
    // lists this module keeps (see `clearCaches` in `catalogs.mjs`) — and the next request
    // reads TMDB again.
    setKey(tmdbKey());
    clearTmdbCache();
    clearCaches();
    // **Put the region lists straight back.** Clearing them left the regional and specialist
    // rows with nothing to be built from, so the refresh's own re-read asked for rows that
    // answered 404 until some other screen happened to prime them again. The drop is what the
    // refresh wants — the *next* answer has to come from TMDB — and this is the re-read.
    await primeRegionProviders().catch(() => {});
    await primeSpecialistCounts().catch(() => {});
    json(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/search/filters.json") {
    json(res, 200, { filters: SEARCH_FILTERS }, 0);
    return true;
  }

  if (pathname === "/manifest.json") {
    // **The For You rows are built from titles**, and the card is published with the
    // list the app is about to read. Priming the pool here (cached for half an hour) is
    // what makes those rows real "More like …" rows on a watchlist that is still empty,
    // instead of the standing genre rows — and the pool is random titles from countries
    // all over the map, not the week's trending list (see `primeForYouSeeds`).
    setKey(tmdbKey());
    await primeForYouSeeds().catch(() => {});
    // **Which services are really in the region**, before the rows are published: a
    // Regional OTT row for a service TMDB does not list in the selected country is a row
    // that opens empty (see `primeRegionProviders`).
    await primeRegionProviders().catch(() => {});
    // **And how much each Specialist row really holds**, so a niche catalogue that answers a
    // single title loses its row on the next build (see `primeSpecialistCounts`).
    await primeSpecialistCounts().catch(() => {});
    json(res, 200, buildManifest(origin));
    return true;
  }

  if (pathname === "/collections.json") {
    setKey(tmdbKey());
    await primeForYouSeeds().catch(() => {});
    await primeRegionProviders().catch(() => {});
    await primeSpecialistCounts().catch(() => {});
    json(res, 200, collectionsPayload(origin.replace(/\/$/, "")));
    return true;
  }

  // Keep the TMDB client on the key configured in Settings (falls back to env).
  setKey(tmdbKey());

  // **A row that was never built is not a row that does not exist.** The regional and
  // specialist rows come from the live region lists; when those are not in hand — a cold
  // start, or the moment after a refresh dropped them — the row cannot be built and the app
  // gets a 404 for something it drew a second ago. Ask once, then resolve.
  if (pathname.startsWith("/catalog/") && !providerListsReady()) {
    await primeRegionProviders().catch(() => {});
  }
  // **The wide title artwork for one title** (`/landscape/movie/550.json`), asked for by
  // the Upcoming card's four tiles (see `landscapeArt`). An empty `url` is a clean answer,
  // not an error: the caller already has a wide shot and keeps it.
  // The id is the one the app carries (`tmdb:550`), and a bare number is the same title.
  const art = pathname.match(/^\/landscape\/(movie|series)\/([\w:-]+)\.json$/);
  if (art) {
    // This runs above the catalog handler's own query object, so it reads its own.
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const language = query.get("lang") || activeLanguage();
    const id = art[2].replace(/^tmdb:/, "");
    // **`?scene=1` is the still of the content** — a wide picture with no text on it, or the
    // trailer's own frame — which is what your own lists draw (see the client's
    // `landscapePoster`). Without it the answer is the title's key art, which is what the
    // spotlight tiles want. `kind` says which of the two came back.
    const answer = hasKey() ? await landscapeArt(art[1], id, language, query.get("scene") === "1") : { url: "", kind: "" };
    json(res, 200, { ok: Boolean(answer.url), url: answer.url, kind: answer.kind }, 6 * 60 * 60);
    return true;
  }

  // **Who can watch this with you** (`/pair/movie/550.json`) — what Watch Along's *Find a
  // pairing* asks for. It answers with **people**, not with other titles: a watch party pairs
  // two watchers (see `watchersFor`).
  const pairing = pathname.match(/^\/pair\/(movie|series)\/([\w:-]+)\.json$/);
  if (pairing) {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const id = pairing[2].replace(/^tmdb:/, "");
    const people = watchersFor(pairing[1], id, { profile: query.get("who") || "", as: query.get("as") || "" });
    json(res, 200, { ok: people.length > 0, people }, 1800);
    return true;
  }

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
    // **And the Arriving row is built out of your own lists** — a pin, a Library title, a Calendar
    // plan — so the rule that keeps watched titles only in your lists would take back every single
    // one of them and leave the row empty. It *is* one of those lists, so it is served whole too.
    const keepWatched = kind === "watchlist" || kind === "custom" || kind === "arriving" || kind === "leaving";
    // **The two dated rows read past their own length** (`LINEUP_ROWS`, see the note on it):
    // both of them lose titles to the gates below, and a reader that asked for fifty titles
    // should get fifty. Only a plain card read tops up — an Explore page reads the row itself
    // (`deep`) and a caller that names a `count` gets the window it asked for.
    // A card's size lives on its **entry** (`curated(name, params, take)` in
    // `scripts/collections.mjs`), not on the catalog that wraps it.
    const lineupTake = Number(parsed.def?.take) || Number(parsed.def?.entry?.take) || 0;
    const wanted = Number(params.get("count")) || 0;
    const topUp = LINEUP_ROWS.has(parsed.def?.name) && lineupTake > 0 && !wanted && params.get("deep") !== "1";
    const metas = withoutWatched(
      parsed.shuffle
        ? await catalogShuffle(parsed.type, parsed.def, parsed.shuffle, { adult, language, sort })
        : await catalogMetas(parsed.type, parsed.def, parsed.skip, { adult, language, sort, exclude, open, count: topUp ? lineupTake + LINEUP_OVER : wanted, over: topUp, deep: params.get("deep") === "1" }),
      keepWatched,
    );
    // **What is leaving, and what has not landed yet.** The two rows of the Updates card are read
    // for their dates before anything is filtered, so the promise they make holds from the first
    // time the card is opened; then a title the app has named as **leaving is dropped from every
    // row** (your own lists and the Updates card itself aside — see `hideGone`).
    //
    // **A title that has not landed is a title like any other now.** It used to be held off every
    // row that is not one of the two "what is coming" cards; the owner's word is that arriving
    // titles are *in* the app — searchable, browsable, in whatever card and filter they belong to
    // ("arriving soon will come in app search and filter ... full titles") — and the only thing
    // they lack is something to play, which the title page says (`Arriving <date>`). The dates
    // still ride on the metas, so a card can wear them whatever row it was read from.
    noteLineup(parsed.def.name, metas);
    const rowCard = cardKeyOfRow(parsed.def.id);
    const shown = withDates(hideNotYet(hideOffShelf(hideGone(metas, keepWatched, rowCard), keepWatched, rowCard), rowCard));
    // The row is its own length again: what the gates dropped is what the top-up replaced.
    if (topUp) shown.length = Math.min(shown.length, lineupTake);
    // Better posters first (it may replace `poster`), then the chosen content
    // source (which owns the poster when it is TVDB), then extra metadata.
    await applyPosters(shown);
    await applyContentSource(shown);
    await enrichRatings(shown);
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
    // **And the Arriving row is your own list too.** It is read out of your pins, your Library rows
    // and your Calendar plans on every request, so a fifteen-minute copy of it would go on saying a
    // title is coming after you had taken it off your list — the bug the watchlist row had.
    const stateful = ["watchlist", "custom", "recommend", "arriving", "leaving"].includes(parsed.def.entry?.kind);
    json(res, 200, { metas: shown }, parsed.shuffle || stateful ? 0 : 900);
  } catch (err) {
    console.error(`[addon] catalog ${parsed.type}/${parsed.def.id} failed:`, err.message);
    json(res, 200, { metas: [] });
  }
  return true;
}
