/**
 * The catalog plan — turns each structured catalog entry in
 * `scripts/collections.mjs` into the TMDB queries that back a row.
 *
 * A card publishes one row per entry it declares, so the cover names and the
 * rows are always the same list. Cards with no entries publish nothing.
 *
 * Only the `catalog` resource is advertised — no search, no discover resource.
 */
import { collectionsFor, catalogEntries, COUNTRIES, countryHasContent, GLOBAL_OTT, isPopularRegional } from "../scripts/collections.mjs";
import { genres, resolveGenre, tmdbPath, get } from "./tmdb.mjs";
import { activeCountry } from "./settings.mjs";
import { list as watchlistState } from "./watchlist.mjs";

export const CATALOG_ID_PREFIX = "autocat-";

/**
 * The region the OTT rows are scoped to — the country set in Settings.
 *
 * It is read per request rather than captured at import: the three regional cards
 * name *your* country's services, so moving the setting has to move the rows.
 */
export const activeRegion = () => activeCountry();

/**
 * The eight rows a For You card falls back to while nothing is pinned.
 *
 * Index 0 is what is trending; the rest are genres, so the card is a spread of
 * different titles instead of the same row eight times. The pairs are `[label,
 * TMDB genre id]`, and the two lists are separate because a movie genre id is not
 * a TV genre id.
 */
const FALLBACK_ROWS = {
  movie: [
    ["Trending now", null],
    ["Action", 28],
    ["Comedy", 35],
    ["Drama", 18],
    ["Thriller", 53],
    ["Adventure", 12],
    ["Sci-Fi", 878],
    ["Animation", 16],
  ],
  series: [
    ["Trending now", null],
    ["Drama", 18],
    ["Comedy", 35],
    ["Sci-Fi & Fantasy", 10765],
    ["Animation", 16],
    ["Crime", 80],
    ["Mystery", 9648],
    ["Action & Adventure", 10759],
  ],
};

const iso = (d) => d.toISOString().slice(0, 10);
const dateField = (media) => (media === "movie" ? "primary_release_date" : "first_air_date");

/** A single TMDB query: where to fetch, what filters, how many items to keep. */
const q = (path, params, take) => ({ path, params, take });

/**
 * **The whole world, in four queries.**
 *
 * The banner's rows — Now Playing, Airing Today, On the Air — are what is out *now*,
 * and TMDB's own endpoints for those answer with the American market: `/movie/now_playing`
 * is a US chart, and the TV pair take no country at all. So "what just came out" meant
 * Hollywood, and what opened in Tokyo, Seoul, Mumbai or Lagos this month was nowhere on
 * the banner.
 *
 * The countries are the same set the **Countries card** publishes — the ones that clear
 * the content floor — and TMDB takes them pipe-separated, so the whole list fits in four
 * discover queries rather than one per country. `CHUNKS` is fixed at import so the same
 * rows are asked for on every request, and a chunk that fails is simply one query short.
 */
const NOW_PLAYING_CHUNKS = (() => {
  const codes = COUNTRIES
    .filter(([name]) => countryHasContent(name, "movie") || countryHasContent(name, "tv"))
    .map(([, code]) => code);
  const size = Math.ceil(codes.length / 4);
  const out = [];
  for (let i = 0; i < codes.length; i += size) out.push(codes.slice(i, i + size));
  return out;
})();

/** "Out now, anywhere" — one discover query per chunk of countries, newest first. */
function worldRecent(media, take, days) {
  const t = tmdbPath(media);
  const since = iso(new Date(Date.now() - days * 864e5));
  return NOW_PLAYING_CHUNKS.map((codes) =>
    q(`/discover/${t}`, {
      with_origin_country: codes.join("|"),
      [`${dateField(media)}.gte`]: since,
      sort_by: "popularity.desc",
      "vote_count.gte": 1,
    }, take),
  );
}

/**
 * The five orders an OTT row can be drawn in — the card's own dropdown.
 *
 * They are five different **questions** about the same service, not five labels for one
 * sort: *latest* is what just came out (a date order with some traction behind it), *newest*
 * is the very front of that date order including the titles with no votes yet, *trending* is
 * what is popular **now** (the last six months by popularity), *popular* is the service's
 * standing hits, and *top rated* is the best-reviewed it holds — which is why that one
 * carries a high vote floor: an average over 200 votes, or a handful of 10s tops the list.
 */
const OTT_SORTS = {
  latest: (media) => ({ sort_by: `${dateField(media)}.desc`, "vote_count.gte": 5 }),
  newest: (media) => ({ sort_by: `${dateField(media)}.desc`, "vote_count.gte": 0 }),
  trending: (media) => ({
    [`${dateField(media)}.gte`]: iso(new Date(Date.now() - 180 * 864e5)),
    sort_by: "popularity.desc",
    "vote_count.gte": 3,
  }),
  popular: () => ({ sort_by: "popularity.desc", "vote_count.gte": 10 }),
  top_rated: () => ({ sort_by: "vote_average.desc", "vote_count.gte": 200 }),
};

/** Does this value name one of the five orders? Anything else is ignored. */
export const isOttSort = (value) => Boolean(OTT_SORTS[value]);

/* ------------------------------------------------------------------ specs */

// `take` is only set where the name implies a fixed size (the ◆ Top 10 rows).
// Without it a row is uncapped, so the app can keep scrolling it — a hard
// default here is what left every row with 20–30 titles.
function presetSpecs(value, media, take, adult = false) {
  const t = tmdbPath(media);
  const tr = (path, params, n) => q(path, adult ? { ...params, include_adult: true } : params, n);
  switch (value) {
    case "trending": return [q(`/trending/${t}/week`, {}, take)];
    case "popular": return [q(`/${t}/popular`, {}, take)];
    case "top_rated": return [q(`/${t}/top_rated`, {}, take)];
    // The /now_playing, /airing_today and /on_the_air endpoints take no
    // include_adult parameter, so the SFW/NSFW switch cannot apply to them.
    // **Out now, everywhere.** The endpoint's own list first (it is the market the
    // endpoint is written for), then the same question asked of every country the
    // Countries card covers.
    case "now_playing": return [q("/movie/now_playing", {}, take), ...worldRecent("movie", take, 45)];
    case "airing_today": return [q("/tv/airing_today", {}, take), ...worldRecent("tv", take, 21)];
    case "on_the_air": return [tr("/tv/on_the_air", {}, take), ...worldRecent("tv", take, 30)];
    // **What is on its way.** Films come from TMDB's own upcoming list; shows have
    // no such endpoint, so the row is the first-air-date order from today on — **the
    // nearest first**, which is what "upcoming" means, and the opposite of the
    // popularity order every other row uses.
    case "upcoming":
      return media === "movie"
        ? [q("/movie/upcoming", {}, take)]
        : [q(`/discover/${t}`, { "first_air_date.gte": iso(new Date()), sort_by: "first_air_date.asc", "vote_count.gte": 1 }, take)];
    case "airing_this_week": {
      const now = new Date();
      const week = new Date(now.getTime() + 7 * 864e5);
      return [
        tr(`/discover/${t}`, {
          "first_air_date.gte": iso(now),
          "first_air_date.lte": iso(week),
          sort_by: "popularity.desc",
          "vote_count.gte": 1,
        }, take),
      ];
    }
    default: return [];
  }
}

/**
 * TMDB queries backing one catalog entry (async: genre names resolve live).
 *
 * `opts.adult` is the SFW/NSFW switch from the app's settings; TMDB defaults to
 * excluding adult titles, so it is only ever set to true.
 */
async function specsFor(entry, media, opts = {}) {
  const t = tmdbPath(media);
  const adult = opts.adult ? { include_adult: true } : {};
  // No `page` here on purpose: the paging pool supplies the page number, and
  // hard-coding page 1 is exactly what stopped rows from going past 20 titles.
  const page = (params, take) => q(`/discover/${t}`, { ...params, ...adult }, take);
  const range = (decade) => ({
    [`${dateField(media)}.gte`]: `${decade}-01-01`,
    [`${dateField(media)}.lte`]: `${decade + 9}-12-31`,
  });

  switch (entry.kind) {
    case "preset":
      return presetSpecs(entry.value, media, entry.take, opts.adult);

    case "discover":
      if (entry.value === "latest") {
        return [page({ sort_by: `${dateField(media)}.desc`, "vote_count.gte": 5 }, entry.take)];
      }
      return [page({ [`${dateField(media)}.gte`]: iso(new Date(Date.now() - 60 * 864e5)), sort_by: "popularity.desc", "vote_count.gte": 5 }, entry.take)];

    // **A row defined by its own filters.** The Discover Plus rows are each one question
    // about the whole catalogue — what is acclaimed, what is a pick, what is a gem — and
    // none of those is one of the preset orders: they are a sort plus the vote floor that
    // makes the sort mean something. `params` is handed to TMDB as written, so the row and
    // the sentence describing it are the same thing (see the card in `collections.mjs`).
    //
    // Two keys in there are the row's own shorthand, turned into the release-date window
    // of whichever media type asked: `within` is a number of days back from today and
    // `before` a year it has to predate. Writing those as TMDB's own two date parameters
    // would mean each row naming `primary_release_date` or `first_air_date` itself, and
    // the same row would then be two different rows for a film and a show.
    case "curated": {
      const { within, before, future, ...rest } = entry.params || {};
      const params = { ...rest };
      if (Number.isFinite(within)) params[`${dateField(media)}.gte`] = iso(new Date(Date.now() - within * 864e5));
      if (Number.isFinite(before)) params[`${dateField(media)}.lte`] = `${before}-12-31`;
      // **"Upcoming", said once for either media type.** A film sorts on
      // `primary_release_date` and a show on `first_air_date`, so a row that means "what
      // arrives next" asks for `date.asc` and gets the right field for what it is; and
      // `future: N` is the window from today to N days out.
      if (params.sort_by === "date.asc" || params.sort_by === "date.desc") {
        params.sort_by = `${dateField(media)}.${params.sort_by.split(".")[1]}`;
      }
      if (Number.isFinite(future)) {
        const now = Date.now();
        params[`${dateField(media)}.gte`] = iso(new Date(now));
        params[`${dateField(media)}.lte`] = iso(new Date(now + future * 864e5));
      }
      return [page(params, entry.take)];
    }

    case "genre": {
      const id = await resolveGenre(media, entry.genre);
      if (!id) return [];
      return [page({ with_genres: id, sort_by: entry.sort === "popular" ? "popularity.desc" : "vote_count.desc", "vote_count.gte": 20 }, entry.take)];
    }

    case "decade":
      return [
        page({
          ...range(entry.decade),
          sort_by: entry.sort === "popular" ? "popularity.desc" : "vote_count.desc",
          "vote_count.gte": entry.sort === "popular" ? 20 : 0,
        }, entry.take),
      ];

    case "genre-decade": {
      const id = await resolveGenre(media, entry.genre);
      if (!id) return [];
      return [page({ with_genres: id, [`${dateField(media)}.gte`]: `${entry.from}-01-01`, sort_by: "popularity.desc", "vote_count.gte": 20 }, entry.take)];
    }

    case "continent":
      return [page({ with_origin_country: entry.codes.join("|"), sort_by: "popularity.desc", "vote_count.gte": 20 }, entry.take)];

    // A low vote floor: TMDB has very little for small industries (Ghana, Kenya),
    // and a high floor emptied those rows entirely.
    case "country":
      return [page({ with_origin_country: entry.code, sort_by: "popularity.desc", "vote_count.gte": 5 }, entry.take)];

    // A length **bucket**: floor and ceiling both, so "30–44 mins" is a row of
    // short films rather than "every popular film over half an hour", which is
    // what every other bucket already was.
    case "runtime": {
      const params = { "with_runtime.gte": entry.min, sort_by: "popularity.desc", "vote_count.gte": 20 };
      if (Number.isFinite(entry.max)) params["with_runtime.lte"] = entry.max;
      return [page(params, entry.take)];
    }

    // **More like what you watch**: TMDB's own recommendation list for each title
    // in your Watchlist — the ones you have finished first, then what you are on,
    // then what you planned — merged into one row by the paging pool. Nothing
    // pinned yet falls back to what is trending, so the card is never empty.
    case "recommend": {
      // A **For You** row carries the title it was built for: the row is that one
      // title's own recommendations.
      // **A seed that cannot fill its row still fills its row.** TMDB answers a title's
      // recommendations with its own neighbours, and a title TMDB marks *adult* has
      // neighbours the SFW filter drops one by one — so a For You row built on that seed
      // resolved to nothing at all, and the card drew blank frames where its posters go.
      // The row now carries a second list behind the seed's own: the seed's neighbours
      // first, then this week's trending titles, so the row a person opens has titles in
      // it whatever their list holds. See `stripAdult` in index.mjs.
      if (entry.seed) {
        return [
          q(`/${t}/${entry.seed.id}/recommendations`, {}, entry.take),
          q(`/trending/${t}/week`, {}, entry.take),
        ];
      }
      if (Number.isFinite(entry.fallback)) {
        // **What the card holds while the watchlist is empty.** One trending row and
        // seven genre rows, so the card is eight rows of *different* titles rather
        // than one fallback repeated — a single row was what "For You has one row"
        // and "its titles never change" both were.
        const roster = FALLBACK_ROWS[media] || FALLBACK_ROWS.movie;
        const row = roster[Math.min(entry.fallback, roster.length - 1)];
        if (row && row[1]) return [page({ with_genres: row[1], sort_by: "popularity.desc", "vote_count.gte": 20 }, entry.take)];
        return [q(`/trending/${t}/week`, {}, entry.take)];
      }
      const pinned = ["watched", "watching", "planned"]
        .flatMap((state) => watchlistState(state))
        .filter((i) => (media === "movie" ? i.type === "movie" : i.type === "series"))
        .map(tmdbIdOf)
        .filter((id) => /^\d+$/.test(id));
      if (!pinned.length) return [q(`/trending/${t}/week`, {}, entry.take)];
      return pinned.map((id) => q(`/${t}/${id}/recommendations`, {}, entry.take));
    }

    // Episode counts cannot be filtered by TMDB discover — the handler builds this
    // row from a pool of shows, keeping those whose count falls inside the bucket.
    // The bucket is a **range** (`min`..`max`), so the 4-episode row and the
    // 24-episode row can never open on the same titles.
    case "episodes":
      return [{ episodes: { min: Number.isFinite(entry.min) ? entry.min : 1, max: Number.isFinite(entry.max) ? entry.max : Infinity } }];

    // Keyword cards ("Books", "Zombie", …). The id is baked in from
    // `tmdb-verified.json` rather than searched at request time: TMDB's keyword
    // search is fuzzy and would answer "based on novel" with "based on visual
    // novel".
    case "keyword":
      // No vote floor: TMDB's keyword supply is thin ("epic" has only a handful
      // of titles with 10+ votes), and a floor left those rows nearly empty.
      // Popularity ordering keeps the recognisable titles at the front.
      return [page({ with_keywords: String(entry.id), sort_by: "popularity.desc", "vote_count.gte": 0 }, entry.take)];

    // An OTT service: a global platform (region = the configured one) or a
    // region's own service (JioHotstar in IN, Stan in AU, …).
    // An OTT service row, in whichever of the five orders the card's own dropdown
    // asked for. With none chosen it is the row it always was — most popular first —
    // so the switch is additive and the default is unchanged.
    case "provider": {
      const order = OTT_SORTS[opts.sort];
      return [
        page({
          with_watch_providers: entry.providerId,
          watch_region: providerRowRegion(entry.providerId, entry.region, media),
          with_watch_monetization_types: "flatrate",
          ...(order ? order(media) : { sort_by: "popularity.desc", "vote_count.gte": 10 }),
        }, entry.take),
      ];
    }

    // A platform's originals: the titles its own studio made. TMDB has no network
    // search endpoint, so a company id is the handle that works for both row
    // types — `probe-originals.mjs` stores one per type where the platform uses
    // two studios (Disney's films come from Walt Disney Pictures, its shows from
    // Walt Disney Television).
    case "original": {
      const studio = entry.studio || {};
      const pick = media === "movie" ? studio.company || studio.tv : studio.tv || studio.company;
      if (!pick) return [];
      return [
        page({
          with_companies: pick.id,
          sort_by: "popularity.desc",
          "vote_count.gte": 10,
        }, entry.take),
      ];
    }

    // The watchlist is not a TMDB query: the handler serves it from the pins the
    // user stored, one row per state. It is still a catalog, so it publishes,
    // scrolls and shuffles like every other row.
    case "watchlist":
      return [{ watchlist: entry.state || "planned" }];

    // A custom row — the one you fill yourself. Same deal: served from the
    // stored titles, not from TMDB, but published and paged as a normal row.
    case "custom":
      return [{ custom: entry.row || "add-cards" }];

    default:
      return [];
  }
}

/**
 * The specs for one entry, with the request's language applied to every query.
 *
 * `opts.language` overrides the Settings language for this one request, so the
 * same catalog can be asked for in two languages at once — and a language switch
 * changes the URL, so it is never answered out of the browser cache. TMDB's own
 * response cache is keyed on the language, so two languages never share a page.
 */
export async function catalogSpecs(entry, media, opts = {}) {
  const specs = await specsFor(entry, media, opts);
  if (!opts.language) return specs;
  return specs.map((s) => (s.params ? { ...s, params: { ...s.params, language: opts.language } } : s));
}

/* ----------------------------------------------------------- catalog defs */

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function buildCatalogDefs(collections) {
  const defs = [];
  const recommendCards = [];
  for (const c of collections) {
    let wantsRecommend = false;
    for (const type of ["movie", "series"]) {
      for (const entry of catalogEntries(c, type === "movie" ? "movie" : "show")) {
        // The **For You** rows are built from your Watchlist — one row per title
        // you watched — so they cannot live in the cached static list. The card is
        // noted here and expanded per request (see `catalogDefs`).
        if (entry.kind === "recommend") {
          wantsRecommend = true;
          continue;
        }
        // A region-scoped service id carries its region, so two regions can never
        // collide on the same service name.
        const region = entry.region ? `-${String(entry.region).toLowerCase()}` : "";
        // **A custom row is keyed by its row id, not its label.** The id of every other
        // catalog is its name; a custom row's name is a setting the user can change at
        // any time, so keying it on the name would move the id — and the row being
        // published — every time someone renamed it.
        const slugPart = entry.kind === "custom" && entry.row ? slug(entry.row) : slug(entry.name);
        defs.push({
          id: `${CATALOG_ID_PREFIX}${c.key}--${slugPart}${region}`,
          type,
          key: c.key,
          entry,
          name: entry.name,
        });
      }
    }
    if (wantsRecommend) recommendCards.push(c);
  }
  return { defs, recommendCards };
}

/**
 * The titles the For You rows are built from: **watched first**, then what you are
 * on, then what you planned. One row per title, named after it.
 */
/**
 * A pinned title's numeric TMDB id.
 *
 * Pins are stored with the app's own namespaced id (`tmdb:73223`), which is what
 * the watchlist row and the title modal key on — so the numeric id the TMDB
 * endpoint needs has to be read out of it. Comparing the raw id against `/^\d+$/`
 * is what kept every For You row on its trending fallback: no pin ever matched.
 */
const tmdbIdOf = (item) => String(item?.id || "").replace(/^tmdb:/, "");

/**
 * The titles For You builds its "more like this" rows from.
 *
 * **Everything you have watched, are watching or have planned**, watched first — a
 * title you watched most recently is the best guess and a title you only planned is
 * still a guess worth making, and the card is about *your* list or it is about
 * nothing. The **order is shuffled per call**, so entering the card re-rolls which of
 * your titles are on it (the manifest and the card's rows are rebuilt on every
 * request — see `catalogDefs`).
 */
function recommendSeeds(type) {
  const seen = new Set();
  const out = [];
  for (const state of ["watched", "watching", "planned"]) {
    for (const item of watchlistState(state)) {
      const id = tmdbIdOf(item);
      if (item?.type !== type || !/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: String(item.name || "this title") });
    }
  }
  // A shuffle, so the rows the card opens on are a different mix each time while
  // still being drawn from your own list.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, FOR_YOU_ROWS_PER_TYPE);
}

/**
 * How many "more like" rows one row type contributes to For You.
 *
 * **Four each**, always: four catalogues on the Movies side and four on the Shows side,
 * the same number whatever the watchlist holds. The rows your own list does not cover
 * are topped up from what is trending and then from the standing roster (see
 * `catalogDefs`), so a short watchlist does not shrink the card.
 */
const FOR_YOU_ROWS_PER_TYPE = 4;

/**
 * The titles a For You row is topped up with — **random titles from anywhere.**
 *
 * **Every For You row is a title, not a genre**, and it is named after the title it was
 * built from (`More Like …`). Your own list supplies those titles while it holds enough;
 * a new watchlist supplies none, so the card has to find them somewhere else.
 *
 * It used to find them in TMDB's **week's-trending list**, which is the same handful of
 * well-known names in every market on earth — so the card opened on "More Like <the
 * popular thing>" on every roll, whatever country the app was set to, and the four rows
 * read as the popular shelf with "More Like" in front of it. The top-up is now a **random
 * walk through the world's catalogues**: a handful of countries drawn at random, one
 * random page of each country's most popular titles, and the names that come back. The
 * pool is rebuilt in the background on a half-hour clock, so a roll is always dealt from
 * a mix of many countries and no request pays for the walk. `catalogDefs` stays
 * synchronous: it deals whatever is in hand, and the next call has the fresh pool.
 */
const forYouPool = { movie: { at: 0, seeds: [] }, series: { at: 0, seeds: [] } };
const FOR_YOU_POOL_TTL = 30 * 60 * 1000;
/** How many countries one walk visits, and how much each one gives. */
const FOR_YOU_POOL_COUNTRIES = 12;
const FOR_YOU_POOL_PER_COUNTRY = 10;

/**
 * **The providers TMDB says are actually in a region.**
 *
 * The Regional OTT card publishes a row per service the region's own data holds **plus the
 * two worldwide ones** (see `regionalOtt` in `scripts/collections.mjs`), and a service TMDB
 * does not list for the selected country answers its discover call with nothing at all —
 * an empty row wearing a service's name. That is what "there are no titles in the Regional
 * OTT card" was: *Viki* in Korea, *Crunchyroll* in Nigeria, a service the card named and
 * could not fill.
 *
 * TMDB's own `/watch/providers` answer for the region is the list to check against, because
 * it is the same data its discover filter reads — a row that survives it is a row that
 * resolves. Cached per region and media type for half a day, refreshed in the background
 * like the For You pool, and **read synchronously** by `catalogDefs`. A region whose list
 * has not arrived yet keeps every row: an unasked question is not a "no", and a first load
 * must not be emptier than the second.
 */
const regionProviders = new Map();
const REGION_PROVIDERS_TTL = 12 * 60 * 60 * 1000;

export async function primeRegionProviders(code = activeCountry()) {
  const region = String(code || "US").toUpperCase();
  // **The United States is always asked.** The six Global OTT platforms and the two
  // worldwide services are read against a region, and the region in Settings is where the
  // *user* is — a country where Prime Video, Max or Paramount+ publish no flatrate catalogue
  // at all (Korea, for one) answered every one of those rows with nothing. The US list is what
  // a global row falls back to (see `providerRowRegion`).
  const regions = region === "US" ? [region] : [region, "US"];
  await Promise.all(
    regions.flatMap((r) => ["movie", "series"].map(async (type) => {
      const slotKey = `${type}:${r}`;
      const held = regionProviders.get(slotKey);
      if (held && Date.now() - held.at < REGION_PROVIDERS_TTL) return;
      try {
        const res = await get(`/watch/providers/${tmdbPath(type)}`, { watch_region: r });
        const rows = (res?.results || [])
          .map((p) => ({
            id: String(p?.provider_id || ""),
            name: String(p?.provider_name || ""),
            priority: Number(p?.display_priority ?? 999),
          }))
          .filter((p) => /^\d+$/.test(p.id) && p.name);
        // Nothing came back: keep whatever the last answer was rather than emptying the
        // set, which would drop every regional row on one bad response.
        if (rows.length) {
          regionProviders.set(slotKey, {
            at: Date.now(),
            ids: new Set(rows.map((p) => p.id)),
            // **TMDB's own popularity order.** Its answer for a region already arrives
            // sorted by `display_priority` — the order a viewer in that region sees the
            // services in — so the head of it is the popular end, by TMDB's own reckoning
            // rather than by a list kept here.
            named: rows.slice().sort((a, b) => a.priority - b.priority),
          });
        }
      } catch {
        /* offline — the rows stand as they are */
      }
    })),
  );
}

/**
 * **The region an OTT row is actually read in.**
 *
 * The Global OTT card's six platforms have no region of their own — they are global — so
 * they used to be read in whatever region Settings held. In a country where a platform
 * publishes nothing (Prime Video, Max and Paramount+ have no flatrate catalogue in Korea)
 * the row came back empty under a platform's name. A global row is read where the platform
 * is, then: the region you are in when the platform is listed there, and the United States
 * — the catalogue every one of these six exists in — when it is not. A row that *does*
 * carry a region (a country's own services) is left exactly as it was.
 */
const GLOBAL_OTT_REGION = "US";
function providerRowRegion(providerId, entryRegion, type) {
  const own = String(entryRegion || "").toUpperCase();
  if (own) return own;
  const here = String(activeRegion() || "").toUpperCase() || GLOBAL_OTT_REGION;
  // Read in your region only when the region is *known* to carry the service; a region
  // whose provider list has not been read yet is not a "no", so it falls back rather
  // than answering empty on the first request after a restart.
  const set = regionProviders.get(`${type}:${here}`)?.ids;
  if (set && set.has(String(providerId))) return here;
  return GLOBAL_OTT_REGION;
}

/**
 * Drop the Regional OTT rows for services TMDB does not list in the row's own region.
 *
 * **Only the Regional OTT cards.** The Global OTT rows are the six platforms the card was
 * designed around and the row is scoped to the region in Settings rather than to a country
 * of its own; trimming those would silently change a card nobody complained about. A row
 * whose region was never asked is kept, so this can only ever remove a row the facts say an
 * empty catalog sits behind.
 */
const withAvailableProviders = (defs) =>
  defs.filter((d) => {
    if (d.entry?.kind !== "provider" || !String(d.key || "").startsWith("regional-ott")) return true;
    const set = regionProviders.get(`${d.type}:${String(d.entry.region || "").toUpperCase()}`)?.ids;
    return !set || set.has(String(d.entry.providerId));
  });

/**
 * **The popular OTT services of a country, in TMDB's own order.**
 *
 * The Regional OTT card used to publish a curated list of service *names* — assembled from
 * whichever regions this project happened to have verified — which is why it could hold a
 * service that had nothing to do with the country on screen and miss the ones a person in
 * it actually subscribes to. It is read off TMDB's answer for **the country the app is set
 * to** now: every service with a catalogue there, already in TMDB's display-priority order.
 *
 * The worldwide platforms and the two Asian-catalogue services are left out — they have
 * their own card (see `GLOBAL_OTT`), and one service belongs to one card family.
 *
 * Returns `null` when that region's list has not arrived yet: an unasked question is not a
 * "no", and the caller keeps what it already has rather than emptying the card.
 */
export function regionalServicesFor(code, type, limit = REGIONAL_ROW_LIMIT) {
  const held = regionProviders.get(`${type}:${String(code || "").toUpperCase()}`)
    || regionProviders.get(`${type}:US`);
  if (!held?.named?.length) return null;
  const here = held.named
    .filter((p) => !GLOBAL_PROVIDER_IDS.has(p.id))
    .filter((p) => !GLOBAL_BRAND.test(p.name))
    .filter((p) => !STORE_LIKE.test(p.name))
    .filter((p) => !CHANNEL_TIER.test(p.name));
  if (!here.length) return null;
  // **The country's own list, in TMDB's order for that country.**
  //
  // This used to keep *only* the names on a short hand-written list, which is how a
  // country TMDB knows eight services in came back with four rows: everything the list
  // did not happen to name was dropped. Reading the region *through* a worldwide list of
  // "popular" names is wrong for the same reason in the other direction — Sun Nxt,
  // Shahid VIP and MUBI led **every** country's card, including ones that do not carry
  // them. The order that means something is TMDB's own `display_priority` for the region
  // (`named` above arrives sorted by it), with the worldwide platforms and their
  // channel-tier variants left to the Global card, and the shops and the art-house
  // catalogues to the STORE_LIKE filter.
  //
  // **The names people know lead; the rest of the country follows.** TMDB's own priority
  // for a region is not a popularity order — it puts the same handful (Sun Nxt, MUBI,
  // Curiosity Stream) first in *every* country — so the hand-written list is used the one
  // way it is both honest and useful: as a **prefix**, and only for services the region
  // actually carries. Everything else the country has comes after it, so the card is the
  // country's own list and never only the four names the list happened to recognise.
  const known = here.filter((p) => isPopularRegional(p.name));
  const rest = here.filter((p) => !isPopularRegional(p.name));
  return [...known, ...rest].slice(0, limit);
}

/**
 * **Stores and aggregators are not streaming services.** TMDB lists the shops (Google Play
 * Movies, Apple TV, JustWatch TV), the aggregators and the pass-throughs beside the real
 * services, and a row called "Google Play Movies" is not a place with a catalogue of its
 * own — it is where a film can be bought. The Regional OTT card is about services you
 * subscribe to.
 */
/* `rakuten tv` and not `rakuten`: TMDB's name for Rakuten Viki is "Rakuten Viki", and the
   loose pattern — meant for the Rakuten TV shop — was dropping a real streaming service the
   Regional OTT card is supposed to carry. */
const STORE_LIKE = /google play|justwatch|apple tv|amazon video|youtube|microsoft|rakuten tv|chili|vudu|fandango|redbox|hoopla|kanopy|plex|eventive|cultpix|takflix|guide?doc|broadwayhd|magellan|filmzie|dekkoo|docalliance|true story|jolt film|netzkino|shadowz|\bpresents plus\b/i;

/**
 * **A channel tier is not a service.** "HBO Max Amazon Channel", "Anime Times Amazon
 * Channel", "HBO Max on U-Next", "Netflix Kids" — these are add-on tiers of a platform
 * that already has its own card, and a Regional row for one of them is a row for Prime
 * Video or Netflix wearing somebody else's name. The country's *own* services are what
 * this card is for.
 */
const CHANNEL_TIER = /amazon channel|netflix kids|on u-next|apple tv channel|\bplus (essential|premium)\b|with ads|standard with ads|basic with ads/i;

/** The worldwide platforms, by provider id — the ones the Global OTT card owns. */
const GLOBAL_PROVIDER_IDS = new Set(GLOBAL_OTT.map(([, id]) => String(id)));

/**
 * **A worldwide brand is never one region's own service, whatever id it arrives under.**
 *
 * TMDB lists the same platform under several provider ids — the plain one, the ad-supported
 * one, an operator's bundle — and the id list above only knows the entry the project verified.
 * A "Regional OTT" row for Amazon Prime Video is a row for a service that has its own card, so
 * the brands are excluded by name as well as by id (the names are TMDB's own, which is exactly
 * how they reach the card).
 */
const GLOBAL_BRAND = /^(amazon prime video|prime video|netflix|disney\+?|disney plus|hbo max|max|apple tv|paramount\+?|paramount plus)\b/i;

/**
 * How many services the Regional OTT card lists for a country.
 *
 * It was fourteen, and the popular names are ordered first — so a country whose list of
 * household names ran long published *only* those and cut the rest, which is how a card about
 * "your region's services" came back missing the ones a viewer in it subscribes to. The
 * country's own list is longer than fourteen in the markets this app covers, so the ceiling is
 * where a row list stops being readable rather than where the data happens to end.
 */
const REGIONAL_ROW_LIMIT = 24;

/** A shuffled copy — the walk's order is the point. */
function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function primeForYouSeeds() {
  await Promise.all(
    ["movie", "series"].map(async (type) => {
      const slot = forYouPool[type];
      if (slot.seeds.length && Date.now() - slot.at < FOR_YOU_POOL_TTL) return;
      const codes = shuffled(COUNTRIES.map(([, code]) => code)).slice(0, FOR_YOU_POOL_COUNTRIES);
      const found = [];
      await Promise.all(
        codes.map(async (code) => {
          // A random page, so visiting the same country twice is not the same ten names.
          const page = 1 + Math.floor(Math.random() * 4);
          try {
            const res = await get(`/discover/${tmdbPath(type)}`, {
              with_origin_country: code,
              sort_by: "popularity.desc",
              "vote_count.gte": 3,
              page,
            });
            for (const r of (res?.results || []).slice(0, FOR_YOU_POOL_PER_COUNTRY)) {
              const id = String(r.id || "");
              if (/^\d+$/.test(id)) found.push({ id, name: r.title || r.name || "this title" });
            }
          } catch {
            /* one country that did not answer is one country fewer in the walk */
          }
        }),
      );
      // Nothing answered: the last pool stands rather than an empty one (the standing
      // roster below is the card's real answer in that case).
      if (!found.length) return;
      const seen = new Set();
      slot.seeds = found.filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
      slot.at = Date.now();
    }),
  );
}

const defsCache = new Map();

/**
 * Every catalog row the addon publishes for one country (movie + series).
 *
 * The static list is memoised per country — the regional OTT rows carry their
 * region in the id, so two countries never collide on the same catalog — but the
 * **For You** rows are rebuilt on every call: a title you just watched has to get
 * its own row without restarting the server.
 */
/**
 * Seed ids the last For You rolls dealt, per card and row type.
 *
 * Every roll drew its four seeds from one pool (your titles plus the week's
 * trending titles, cached for half an hour) with no memory between rolls, so
 * consecutive opens kept dealing the same names back — one title on every open.
 * The last two rolls' seeds are held aside now and only replayed when the pool
 * runs dry, so the next open is different rows, not the same ones reshuffled.
 */
const recentForYouSeeds = new Map();
/** Two rolls' worth of seeds per card and row type. */
const FOR_YOU_SEED_MEMORY = FOR_YOU_ROWS_PER_TYPE * 2;

/**
 * **The Regional OTT cards hold *every* region's services — one country only tops them up.**
 *
 * The card's body is the regional OTT data itself (`regionalOtt` in `scripts/collections.mjs`),
 * one row per service, plus the household names of each continent
 * (`regionalOttByContinent`). TMDB's answer for the country the app is set to (see
 * `regionalServicesFor`) is the **last** thing done to it, and only for a service the card
 * does not already carry: the country setting is where you are, not what the card is about, and
 * leading with it turned an all-continent card into one country's list.
 */
function withRegionalServices(defs, code) {
  const movie = regionalServicesFor(code, "movie");
  const series = regionalServicesFor(code, "series");
  if (!movie && !series) return defs;
  // **The region's own rows are replaced; the continents' are kept.** This used to drop
  // *every* `regional-ott` def, so the continent rows the card publishes wider
  // (`regionalOttByContinent`, flagged `wider`) vanished the moment TMDB's list for the
  // region arrived — the card looked like the rows had never been added at all. A wider row
  // is not this region's service, so it is not what this list is replacing.
  // Both regional cards are the same list read twice: the plain one, and the Top 10 the
  // service publishes for itself.
  const CARDS = [
    ["regional-ott", (svc) => svc.name, 40],
    ["regional-ott-top-10", (svc) => `${svc.name} | Top 10`, 10],
  ];
  const own = new Map(CARDS.map(([cardKey]) => [cardKey, []]));
  for (const [cardKey, rowName, take] of CARDS) {
    for (const [type, rows] of [["movie", movie], ["series", series]]) {
      if (!rows) continue;
      for (const svc of rows) {
        const name = rowName(svc);
        own.get(cardKey).push({
          id: `${CATALOG_ID_PREFIX}${cardKey}--${slug(svc.name)}-${String(code).toLowerCase()}`,
          type,
          key: cardKey,
          entry: { kind: "provider", providerId: svc.id, region: String(code).toUpperCase(), name, take },
          name,
        });
      }
    }
  }
  // **The cards as published, and the country's list only where it adds something.** Every
  // region's services and the continents' rows keep the place the cards gave them; the country
  // the app is set to follows at the end, and a service the card already carries is not
  // published twice (the app being set to the US is no reason for a second Hulu beside the row
  // the regional data already put there). The check is per card, because the plain card and the
  // Top 10 card are meant to carry the same services.
  const published = new Set(
    defs
      .filter((d) => String(d.key || "").startsWith("regional-ott"))
      .map((d) => `${d.key}:${d.entry?.providerId ?? ""}`),
  );
  const out = [...defs];
  for (const [cardKey] of CARDS) {
    for (const row of own.get(cardKey) || []) {
      const key = `${cardKey}:${row.entry.providerId}`;
      if (published.has(key)) continue;
      published.add(key);
      out.push(row);
    }
  }
  return out;
}

export function catalogDefs(code = activeCountry()) {
  const key = String(code || "US").toUpperCase();
  if (!defsCache.has(key)) defsCache.set(key, buildCatalogDefs(collectionsFor(key)));
  const { defs, recommendCards } = defsCache.get(key);
  if (!recommendCards.length) return withAvailableProviders(withRegionalServices(defs, key));
  // **The rows are published even with an empty watchlist.** Withholding them left
  // the For You card with no rows at all, so it could not show anything; with nothing
  // pinned each row falls back to what is trending (the `recommend` case in
  // `specsFor`), which is why the card is never empty.
  return [
    ...withAvailableProviders(withRegionalServices(defs, key)),
    ...recommendCards.flatMap((c) => {
      const rows = [];
      // **Per row type**, not per card: a watchlist holding only shows must still
      // leave the Movies row standing. Deciding this once for the whole card made
      // the Movies row vanish as soon as a single show was pinned.
      for (const type of ["movie", "series"]) {
        const mine = [];
        // **One pool, one shuffle.** Your own titles used to be laid into the rows
        // *first*, so a watchlist holding two shows gave those same two shows a slot on
        // every single roll — the card said "More Like NCIS · More Like Family Guy"
        // however many times it was opened, which is the "NCIS is in For You shows
        // every time" report. The rows are now drawn from your titles **and** the random
        // any-country pool as one shuffled pool, so a roll is a genuine mix: your own
        // list is still the first source it draws from, it is simply no longer a fixed
        // prefix that fills the card before anything else is considered.
        //
        // Every row is still a *title* (never a genre), and the standing roster below
        // only appears when even the pool is short. See `findCatalog` for how the ids
        // keep resolving across rolls.
        const pool = [
          ...recommendSeeds(type).map((seed) => ({ seed })),
          ...forYouPool[type].seeds.map((seed) => ({ seed })),
        ];
        const memKey = `${c.key}:${type}`;
        const remembered = new Set(recentForYouSeeds.get(memKey) || []);
        const held = [];
        const used = new Set();
        const deal = (replay) => {
          while (mine.length < FOR_YOU_ROWS_PER_TYPE && pool.length) {
            const [pick] = pool.splice(Math.floor(Math.random() * pool.length), 1);
            if (used.has(pick.seed.id)) continue;
            if (!replay && remembered.has(pick.seed.id)) {
              held.push(pick);
              continue;
            }
            used.add(pick.seed.id);
            mine.push({
              id: `${CATALOG_ID_PREFIX}${c.key}--${type}--${pick.seed.id}`,
              type,
              key: c.key,
              entry: { kind: "recommend", seed: pick.seed },
              name: `More Like ${pick.seed.name}`,
            });
          }
        };
        deal(false);
        // Small pool, or everything remembered: replay the held seeds rather than
        // leaving the card short. A title can only repeat here when there was
        // nothing fresh left to deal.
        if (mine.length < FOR_YOU_ROWS_PER_TYPE && held.length) {
          pool.push(...held);
          deal(true);
        }
        recentForYouSeeds.set(
          memKey,
          [
            ...mine.map((r) => r.entry.seed?.id).filter(Boolean),
            ...(recentForYouSeeds.get(memKey) || []),
          ].slice(0, FOR_YOU_SEED_MEMORY),
        );
        if (recentForYouSeeds.size > 40) recentForYouSeeds.delete(recentForYouSeeds.keys().next().value);
        // Still short (no TMDB answer yet, or no watchlist and no trending): the
        // standing rows, which are named as "more like" rows too.
        const roster = FALLBACK_ROWS[type === "movie" ? "movie" : "series"];
        const indexes = roster.map((_, i) => i);
        for (let i = indexes.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
        }
        for (const i of indexes) {
          if (mine.length >= FOR_YOU_ROWS_PER_TYPE) break;
          mine.push({
            id: `${CATALOG_ID_PREFIX}${c.key}--${type}--f${i}`,
            type,
            key: c.key,
            entry: { kind: "recommend", fallback: i },
            name: `More Like ${roster[i][0]}`,
          });
        }
        rows.push(...mine);
      }
      return rows;
    }),
  ];
}

// Stremio identifies a catalog by (type, id) — the same id is used for the movie
// and series variants, so lookups must match on both.
//
// **A For You id is rebuilt if the current split does not hold it.** Both its
// flavours carry everything the row needs — the title it was built for, or the
// fallback index — and the seed list is re-rolled on every call, so the id the
// manifest published a moment ago can be missing from the set built now. Dropping
// it would make the row it names open empty.
export const findCatalog = (id, type) => {
  const found = catalogDefs().find((d) => d.id === id && d.type === type);
  if (found) return found;
  // **Both prefixes.** The id was `autocat-…` until the app was renamed, and this regex
  // was the one place the old name was left behind — so every id a re-roll had dropped
  // from the current set fell through to "not found" and the row it named opened with
  // nothing in it: the blank frames the For You card drew. It reads either prefix now.
  const m = /^(?:autocat|autocat)-(.+?)--(movie|series)--(?:f(\d+)|(\d+))$/.exec(String(id || ""));
  if (!m || m[2] !== type) return null;
  return m[3]
    ? { id, type, key: m[1], entry: { kind: "recommend", fallback: Number(m[3]) }, name: "For You" }
    : { id, type, key: m[1], entry: { kind: "recommend", seed: { id: m[4], name: "this title" } }, name: "More Like" };
};

export { genres };
