/**
 * The Nuvio collection set — single source of truth.
 *
 * Shared by the cover generator (`scripts/generate-covers.mjs`) and the catalog
 * addon (`addon/catalogs.mjs`), so the cover art and the catalog rows can never
 * drift apart. Order matters: it is the row order in the Nuvio home screen.
 *
 *   key       stable id — also the cover filename and the catalog id suffix
 *   lines     the title, split across lines for the cover
 *   catalogs  the catalogs inside this card, per row: { movie: [...], show: [...] }
 *
 * **Nothing here is guessed.** Genre names, provider ids and keyword ids all
 * come from `tmdb-verified.json`, produced by `scripts/probe-tmdb.mjs` against
 * the live TMDB API and checked to actually return titles. Guessing any of them
 * is what used to produce rows with no titles in them (TMDB renamed HBO Max to
 * Max, moved Paramount+ in the US, and its keyword search returns "based on
 * visual novel" for "based on novel").
 *
 * Catalog entry kinds and their params:
 *
 *   preset        value: trending | popular | top_rated | now_playing |
 *                 airing_today | airing_this_week | on_the_air
 *   discover      value: latest | new
 *   curated       params: TMDB discover filters, written as they are sent —
 *                 plus `within` (days) and `before` (year), which are turned
 *                 into the release-date window for the row's own media type
 *   genre         genre, sort?: "popular"
 *   decade        decade (e.g. 1950), sort?: "popular"
 *   genre-decade  genre, from
 *   continent     codes: ["JP", …]
 *   country       code: "IN"
 *   runtime       min: 30
 *   episodes      max: 4
 *   keyword       id   (verified TMDB keyword id)
 *   provider      providerId, region   (an OTT service in that region)
 *   watchlist     state: planned | watching | watched   (served from the pins)
 *
 *   `take` caps how many titles a catalog keeps. It is only used where the name
 *   promises a fixed size (a ◆ Top 10 really is ten titles) — anywhere else it
 *   is left off, because a capped row is a row that stops scrolling.
 *
 * NOTE on symbols: covers render with the bundled Inter fonts and system fonts
 * are disabled, so a glyph Inter lacks renders as a box. `✦` and `➜` are NOT in
 * Inter — `◆`, `→`, `★`, `·`, `•`, `–`, `—` are. Only use those.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const VERIFIED = require("./tmdb-verified.json");

/**
 * The decades, **newest first**.
 *
 * The card lists them in the order this array holds, and the decade you want is almost
 * always the one you are in — 2020s first, then 2010s, and back to the 1950s. Oldest
 * first meant scrolling the whole strip to reach the row that is usually the answer.
 */
const ALL_DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950];

export const MOVIE_GENRES = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family",
  "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Science Fiction",
  "Thriller", "War", "Western",
];

export const SHOW_GENRES = [
  "Action & Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family",
  "Kids", "Mystery", "News", "Reality", "Sci-Fi & Fantasy", "Soap", "Talk",
  "War & Politics", "Western",
];

export const CONTINENTS = {
  Asia: ["JP", "KR", "CN", "IN", "TH", "ID", "PH", "TW", "HK", "MY", "SG", "VN", "PK", "LK", "BD"],
  Europe: ["GB", "FR", "DE", "IT", "ES", "SE", "NO", "DK", "NL", "PL", "RU", "IE", "PT", "GR", "UA", "CZ", "HU", "RO", "FI", "CH", "BE", "AT", "BG", "RS", "HR"],
  "North America": ["US", "CA", "MX"],
  "South America": ["BR", "AR", "CO", "CL", "PE"],
  Africa: ["NG", "ZA", "EG", "KE", "MA", "GH"],
  Oceania: ["AU", "NZ"],
};

/**
 * **A country is published when it has anything at all. There is no size rule.**
 *
 * There used to be a floor here, and it was wrong twice over. First it was compared
 * against a table that held **one page's worth** of each country (20 at most), so eleven
 * films and seven thousand looked identical and the number meant nothing. Then, measured
 * properly, a floor of ten turned TMDB's own coverage of a country into a verdict on that
 * country: Pakistan (38 films, 14 shows), Bangladesh (132/11), Sri Lanka (30/3),
 * Uzbekistan (7), Tonga (1 show) and dozens more were unpublished — no row, no chip, no
 * way in — because TMDB returns fewer titles for them than it does for the United
 * States. That is not a quality judgment this file gets to make, and "there is less of
 * it" is not "there is none of it".
 *
 * So the rule was the smallest true one: **if TMDB has any title for a country on a
 * row type, that country gets that row** — until the user asked for the opposite:
 * countries with **fewer than fifty titles** on a row type are out, `MIN_COUNTRY_TITLES
 * = 50`, still asked **per type**. This cuts real catalogs, and that is the point of
 * writing it down: Pakistan's 38-film row goes, Qatar (41 films / 2 shows) goes
 * entirely, Sri Lanka (30/3), Nepal (20 films), Azerbaijan (16), Bermuda (11),
 * Uzbekistan (7), Indonesia's 21-show row (its 592 films stay), Bangladesh's 11-show
 * row (its 132 films stay), Thailand keeps 629/433 and Egypt 724/117. The 29 named
 * removals (`REMOVED_COUNTRY_NAMES`) still apply on top, and the 36 territories TMDB
 * returns nothing for were never published.
 *
 * `countryHasContent` is what everything reads — the Countries card's rows, the search
 * panel's country chips, the cross-country shuffle pool and the continent rows — so no
 * screen can offer a country another screen does not.
 */
export const MIN_COUNTRY_TITLES = 50;

/**
 * **Published nowhere: the places the user asked out.**
 *
 * Three sets, sitting in the one function every surface reads — so a name here
 * disappears from the Countries card's rows, the search panel's country chips,
 * the cross-country shuffle pool and the continent rows, and from the Regional OTT
 * cards too (a regional service row stays only while its country is on the Countries
 * card — see `REGIONAL_SERVICES`, which already filters on this).
 *
 * 1. **Uninhabited territories** — Antarctica, the French Southern Territories, South
 *    Georgia and the South Sandwich Islands, Svalbard & Jan Mayen. (Bouvet, Heard &
 *    McDonald, the US Minor Outlying Islands, Pitcairn and the rest of that family
 *    return nothing at all, so they were never published.)
 * 2. **One-title rows** — American Samoa, Belize, "Guadaloupe" (TMDB's spelling for
 *    Guadeloupe), Guyana, Kiribati, Mayotte, Nauru, Niue, Norfolk Island, Oman,
 *    Tokelau, Tonga, the Turks and Caicos Islands, Tuvalu and the US Virgin Islands,
 *    each of which holds a single title in TMDB's list — a row that can never be more
 *    than one poster — **plus Brunei Darussalam (2 films), Myanmar (5) and Timor-Leste
 *    (1)**, named directly by the user for removal.
 * 3. **Administered territories** — Bermuda, the Falkland Islands, the Faeroe Islands,
 *    French Polynesia, Gibraltar, Greenland, Guam, Martinique and Réunion: places
 *    administered from elsewhere rather than countries of their own.
 * 4. **States that no longer exist** — the Soviet Union (2,350 films), Yugoslavia
 *    (651), Czechoslovakia (648), East Germany (139), Serbia and Montenegro and the
 *    Netherlands Antilles. This hides thousands of old films filed under dead states;
 *    that is the trade the user asked for, stated here so it can be undone by deleting
 *    six names. Their regions hold no streaming services, so no Regional OTT row goes
 *    with them — the services all survive, only the six dead-state rows do not.
 *
 * This is a **named list, not a size rule**: Pakistan (38 films / 14 shows),
 * Bangladesh (132/11), Malta, Luxembourg, Iceland, Greenland's neighbours that *are*
 * countries — none of those are touched, whatever their counts.
 */
/**
 * **Kept by name, whatever the numbers say.**
 *
 * Pakistan and Bangladesh are published on **both** rows — films and shows — even
 * where the fifty-title floor would take them (Pakistan's 38 films, its 14 shows,
 * Bangladesh's 11 shows). The user asked for the under-fifty rule *and* for these two
 * countries to stay; both instructions stand, so the two names are exempted here
 * rather than argued with. Everything else under fifty is out.
 */
const KEPT_COUNTRY_NAMES = new Set([
  "Pakistan", "Bangladesh",
  // **Southeast Asia stays, except the three the user named.** The fifty-title floor
  // cut real ASEAN countries whose TMDB coverage is thin, and the user said these
  // were never "less known" — so Cambodia (16 films), Laos (10), Vietnam (117/9),
  // Indonesia (592/21), Malaysia (145/11), Singapore (149/22), the Philippines (800/74)
  // and Thailand (629/433) publish wherever they have anything. Brunei Darussalam (2),
  // Myanmar (5) and Timor-Leste (1) are explicitly out — see the removed lists below.
  "Cambodia", "Indonesia", "Lao People's Democratic Republic", "Malaysia", "Philippines", "Singapore", "Thailand", "Vietnam",
]);

const REMOVED_COUNTRY_NAMES = new Set([
  "Antarctica", "French Southern Territories", "South Georgia and the South Sandwich Islands", "Svalbard & Jan Mayen Islands",
  "American Samoa", "Belize", "Guadaloupe", "Guyana", "Kiribati", "Mayotte", "Nauru", "Niue", "Norfolk Island", "Oman", "Tokelau", "Tonga", "Turks and Caicos Islands", "Tuvalu", "US Virgin Islands",
  // Named removals the user asked for directly: Brunei Darussalam (2 films), Myanmar
  // (5) and Timor-Leste (1) — thin catalogs the user does not want rows for.
  "Brunei Darussalam", "Myanmar", "Timor-Leste",
  "Bermuda", "Falkland Islands", "Faeroe Islands", "French Polynesia", "Gibraltar", "Greenland", "Guam", "Martinique", "Reunion",
  "Soviet Union", "Yugoslavia", "Czechoslovakia", "East Germany", "Serbia and Montenegro", "Netherlands Antilles",
]);

/** Does this country clear the floor on this row ("movie" or "show")? */
export const countryHasContent = (name, type) => {
  const c = VERIFIED.countries?.[name];
  // A kept name wins over every rule, including the removed list.
  if (KEPT_COUNTRY_NAMES.has(name)) return ((type === "show" ? c?.tvCount : c?.movieCount) || 0) > 0;
  if (REMOVED_COUNTRY_NAMES.has(name)) return false;
  return ((type === "show" ? c?.tvCount : c?.movieCount) || 0) >= MIN_COUNTRY_TITLES;
};

/** The same question asked of an ISO code — an unknown code is kept, not dropped. */
const codeHasContent = (code) => {
  const want = String(code || "").toUpperCase();
  const row = COUNTRIES.find(([, c]) => c === want);
  if (!row) return true;
  return countryHasContent(row[0], "movie") || countryHasContent(row[0], "show");
};

/**
 * Every continent, each with the countries of it that clear the floor.
 *
 * The continents themselves are not dropped — a continent is a large enough query on its
 * own — only the thin countries inside their lists are, and a continent left with none
 * would go rather than be published as a row that can only come back empty.
 */
export const continentsWithContent = () =>
  Object.entries(CONTINENTS)
    .map(([name, codes]) => [name, codes.filter(codeHasContent)])
    .filter(([, codes]) => codes.length);

// The Countries card's list — **every** country and territory TMDB knows, taken
// from its own `/configuration/countries`, with a handful renamed where TMDB uses
// the same name twice (the two Congos) or a historical one.
//
// Nothing here is assumed to have content: `probe-countries.mjs` records each
// country's real title counts, and `countriesFor` publishes only the countries a
// row actually has titles for, so an island with no film industry contributes
// nothing but costs nothing either.
export const COUNTRIES = [
  ["United States", "US"], ["India", "IN"], ["Japan", "JP"], ["South Korea", "KR"],
  ["United Kingdom", "GB"], ["France", "FR"], ["Spain", "ES"], ["Germany", "DE"],
  ["Italy", "IT"], ["China", "CN"], ["Mexico", "MX"], ["Brazil", "BR"],
  ["Turkey", "TR"], ["Australia", "AU"], ["Canada", "CA"], ["Nigeria", "NG"],
  ["Russia", "RU"], ["Netherlands", "NL"], ["Sweden", "SE"], ["Norway", "NO"],
  ["Denmark", "DK"], ["Poland", "PL"], ["Ireland", "IE"], ["Portugal", "PT"],
  ["Greece", "GR"], ["Argentina", "AR"], ["Colombia", "CO"], ["Chile", "CL"],
  ["Peru", "PE"], ["Egypt", "EG"], ["South Africa", "ZA"], ["Kenya", "KE"],
  ["Morocco", "MA"], ["Ghana", "GH"], ["Israel", "IL"], ["Saudi Arabia", "SA"],
  ["United Arab Emirates", "AE"], ["Indonesia", "ID"], ["Thailand", "TH"], ["Philippines", "PH"],
  // Added: more countries with a good amount of content.
  ["Taiwan", "TW"], ["Hong Kong", "HK"], ["Malaysia", "MY"], ["Singapore", "SG"],
  ["Vietnam", "VN"], ["Pakistan", "PK"], ["Bangladesh", "BD"], ["Sri Lanka", "LK"],
  ["New Zealand", "NZ"], ["Ukraine", "UA"], ["Czech Republic", "CZ"], ["Hungary", "HU"],
  ["Romania", "RO"], ["Finland", "FI"], ["Switzerland", "CH"], ["Belgium", "BE"],
  ["Austria", "AT"], ["Bulgaria", "BG"], ["Serbia", "RS"], ["Croatia", "HR"],
  // Added: the second wave, each one screened for having titles on TMDB before it
  // was written down here.
  ["Iceland", "IS"], ["Slovakia", "SK"], ["Slovenia", "SI"], ["Lithuania", "LT"],
  ["Latvia", "LV"], ["Estonia", "EE"], ["Bosnia and Herzegovina", "BA"], ["Albania", "AL"],
  ["North Macedonia", "MK"], ["Malta", "MT"], ["Luxembourg", "LU"], ["Cyprus", "CY"],
  ["Moldova", "MD"], ["Georgia", "GE"], ["Kazakhstan", "KZ"], ["Nepal", "NP"],
  ["Lebanon", "LB"], ["Iraq", "IQ"], ["Jordan", "JO"], ["Kuwait", "KW"],
  ["Qatar", "QA"], ["Venezuela", "VE"], ["Uruguay", "UY"], ["Ecuador", "EC"],
  ["Bolivia", "BO"], ["Paraguay", "PY"], ["Costa Rica", "CR"], ["Panama", "PA"],
  ["Dominican Republic", "DO"], ["Puerto Rico", "PR"], ["Guatemala", "GT"], ["Cuba", "CU"],
  ["Tunisia", "TN"], ["Algeria", "DZ"], ["Senegal", "SN"],
  // Added: everything else TMDB lists. Territories stay listed here (the list is
  // geography, not publishing), but the historical countries do not publish: the
  // Soviet Union, Yugoslavia, Czechoslovakia, East Germany, Serbia and Montenegro
  // and the Netherlands Antilles are in `REMOVED_COUNTRY_NAMES` — states that no
  // longer exist are not countries, however many titles TMDB files under them.
  ["Afghanistan", "AF"], ["American Samoa", "AS"], ["Andorra", "AD"], ["Angola", "AO"],
  ["Anguilla", "AI"], ["Antarctica", "AQ"], ["Antigua and Barbuda", "AG"], ["Armenia", "AM"],
  ["Aruba", "AW"], ["Azerbaijan", "AZ"], ["Bahamas", "BS"], ["Bahrain", "BH"],
  ["Barbados", "BB"], ["Belarus", "BY"], ["Belize", "BZ"], ["Benin", "BJ"],
  ["Bermuda", "BM"], ["Bhutan", "BT"], ["Botswana", "BW"], ["Bouvet Island", "BV"],
  ["British Indian Ocean Territory", "IO"], ["British Virgin Islands", "VG"], ["Brunei Darussalam", "BN"], ["Burkina Faso", "BF"],
  ["Burma", "BU"], ["Burundi", "BI"], ["Cambodia", "KH"], ["Cameroon", "CM"],
  ["Cape Verde", "CV"], ["Cayman Islands", "KY"], ["Central African Republic", "CF"], ["Chad", "TD"],
  ["Christmas Island", "CX"], ["Cocos  Islands", "CC"], ["Comoros", "KM"], ["Congo (DRC)", "CD"],
  ["Congo (Republic)", "CG"], ["Cook Islands", "CK"], ["Cote D'Ivoire", "CI"], ["Czechoslovakia", "XC"],
  ["Djibouti", "DJ"], ["Dominica", "DM"], ["East Germany", "XG"], ["East Timor", "TP"],
  ["El Salvador", "SV"], ["Equatorial Guinea", "GQ"], ["Eritrea", "ER"], ["Ethiopia", "ET"],
  ["Faeroe Islands", "FO"], ["Falkland Islands", "FK"], ["Fiji", "FJ"], ["French Guiana", "GF"],
  ["French Polynesia", "PF"], ["French Southern Territories", "TF"], ["Gabon", "GA"], ["Gambia", "GM"],
  ["Gibraltar", "GI"], ["Greenland", "GL"], ["Grenada", "GD"], ["Guadaloupe", "GP"],
  ["Guam", "GU"], ["Guinea", "GN"], ["Guinea-Bissau", "GW"], ["Guyana", "GY"],
  ["Haiti", "HT"], ["Heard and McDonald Islands", "HM"], ["Holy See", "VA"], ["Honduras", "HN"],
  ["Iran", "IR"], ["Jamaica", "JM"], ["Kiribati", "KI"], ["Kosovo", "XK"],
  ["Kyrgyz Republic", "KG"], ["Lao People's Democratic Republic", "LA"], ["Lesotho", "LS"], ["Liberia", "LR"],
  ["Libyan Arab Jamahiriya", "LY"], ["Liechtenstein", "LI"], ["Macao", "MO"], ["Madagascar", "MG"],
  ["Malawi", "MW"], ["Maldives", "MV"], ["Mali", "ML"], ["Marshall Islands", "MH"],
  ["Martinique", "MQ"], ["Mauritania", "MR"], ["Mauritius", "MU"], ["Mayotte", "YT"],
  ["Micronesia", "FM"], ["Monaco", "MC"], ["Mongolia", "MN"], ["Montenegro", "ME"],
  ["Montserrat", "MS"], ["Mozambique", "MZ"], ["Myanmar", "MM"], ["Namibia", "NA"],
  ["Nauru", "NR"], ["Netherlands Antilles", "AN"], ["New Caledonia", "NC"], ["Nicaragua", "NI"],
  ["Niger", "NE"], ["Niue", "NU"], ["Norfolk Island", "NF"], ["North Korea", "KP"],
  ["Northern Ireland", "XI"], ["Northern Mariana Islands", "MP"], ["Oman", "OM"], ["Palau", "PW"],
  ["Palestinian Territory", "PS"], ["Papua New Guinea", "PG"], ["Pitcairn Island", "PN"], ["Reunion", "RE"],
  ["Rwanda", "RW"], ["Samoa", "WS"], ["San Marino", "SM"], ["Sao Tome and Principe", "ST"],
  ["Serbia and Montenegro", "CS"], ["Seychelles", "SC"], ["Sierra Leone", "SL"], ["Solomon Islands", "SB"],
  ["Somalia", "SO"], ["South Georgia and the South Sandwich Islands", "GS"], ["South Sudan", "SS"], ["Soviet Union", "SU"],
  ["St. Helena", "SH"], ["St. Kitts and Nevis", "KN"], ["St. Lucia", "LC"], ["St. Pierre and Miquelon", "PM"],
  ["St. Vincent and the Grenadines", "VC"], ["Sudan", "SD"], ["Suriname", "SR"], ["Svalbard & Jan Mayen Islands", "SJ"],
  ["Swaziland", "SZ"], ["Syrian Arab Republic", "SY"], ["Tajikistan", "TJ"], ["Tanzania", "TZ"],
  ["Timor-Leste", "TL"], ["Togo", "TG"], ["Tokelau", "TK"], ["Tonga", "TO"],
  ["Trinidad and Tobago", "TT"], ["Turkmenistan", "TM"], ["Turks and Caicos Islands", "TC"], ["Tuvalu", "TV"],
  ["Uganda", "UG"], ["United States Minor Outlying Islands", "UM"], ["US Virgin Islands", "VI"], ["Uzbekistan", "UZ"],
  ["Vanuatu", "VU"], ["Wallis and Futuna Islands", "WF"], ["Western Sahara", "EH"], ["Yemen", "YE"],
  ["Yugoslavia", "YU"], ["Zaire", "ZR"], ["Zambia", "ZM"], ["Zimbabwe", "ZW"],
];

/** The ISO codes of the removed countries (see `REMOVED_COUNTRY_NAMES`) — the
 * settings picker and anything else that lists countries by code instead of by
 * row, so a place published nowhere is not offered as a choice anywhere. */
export const REMOVED_COUNTRY_CODES = new Set(
  COUNTRIES.filter(([name]) => REMOVED_COUNTRY_NAMES.has(name)).map(([, code]) => code),
);

// The Global OTT cards publish **six** platforms: the ones they were built
// with. Hulu is a US service and was never one of them.
//
// A platform the probe verifies later stays in `PLATFORMS` — the fact list the probe
// writes and the selftest checks — but does **not** become a seventh global row, so
// the cards keep the composition they were designed around.
export const GLOBAL_PLATFORMS = ["Netflix", "Prime Video", "Disney+", "Max", "Apple TV+", "Paramount+"];

/** Those six, resolved against the verified facts — [label, TMDB provider id]. */
export const GLOBAL_OTT = GLOBAL_PLATFORMS.map((label) => {
  const hit = VERIFIED.platforms.find((p) => p.id && p.label === label);
  return hit ? [hit.label, hit.id] : null;
}).filter(Boolean);

// Crunchyroll and Rakuten Viki are the two Asian-catalogue services, and they belong
// to the **Regional OTT** rows (added for every country, see `WORLDWIDE` below)
// rather than to the Global OTT set — one service, one card family, never both.
const ASIAN_ONLY = new Set(["Crunchyroll", "Viki"]);

/**
 * Every global platform the facts hold — [label, TMDB provider id].
 *
 * `probe-tmdb.mjs` verifies these and `probe-platforms.mjs` appends newly verified
 * ones. The *cards* draw from `GLOBAL_OTT`, not from this list.
 */
export const PLATFORMS = VERIFIED.platforms
  .filter((p) => p.id && !ASIAN_ONLY.has(p.label))
  .map((p) => [p.label, p.id]);

export const DECADES = ALL_DECADES;

/** Up to `LOCAL_LIMIT` local OTT services per region, verified to return titles. */
export const LOCAL_LIMIT = 8;
const localFor = (region, type) => (VERIFIED.regions[region]?.[type] ?? []).slice(0, LOCAL_LIMIT);

/**
 * The regional OTT data's own region labels, by ISO code.
 *
 * `tmdb-verified.json` records every region under its name *and* carries the code on
 * the entry itself, so the Regional OTT cards resolve a code straight out of the
 * regional OTT data. They used to resolve it through the Countries card's label list,
 * which made one card family depend on another card's list — and a region the
 * regional OTT data held but that list did not would have had no rows at all.
 */
const REGION_NAMES = new Map(
  Object.entries(VERIFIED.regions).map(([name, entry]) => [String(entry.code || "").toUpperCase(), name]),
);

/** The regional OTT data's name for an ISO code ("" when it holds none). */
export const regionName = (code) => REGION_NAMES.get(String(code || "").toUpperCase()) || "";

/**
 * Services that belong in **every** region's Regional OTT card.
 *
 * Crunchyroll and Viki (TMDB's name for Rakuten Viki) are the Asian-catalogue
 * services. Sitting in the Global OTT card meant anime and Asian drama never
 * appeared in the regional rows even though both are local to nearly every region
 * the app covers, which read as "the regional cards have no anime in them". They
 * join the region's own list, after the local ones — a country's own services
 * still come first — and they are deliberately *not* in the Global OTT set, so each
 * service lives in exactly one of the two OTT card families instead of being
 * counted twice.
 */
const WORLDWIDE = (VERIFIED.platforms || [])
  .filter((p) => p.id && (p.label === "Crunchyroll" || p.label === "Viki"))
  .map((p) => ({ id: p.id, name: p.label }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The verified local services for a country, plus the worldwide ones. */
export const localServices = (code, type) => {
  const local = localFor(regionName(code), type);
  const seen = new Set(local.map((s) => s.id));
  return [...local, ...WORLDWIDE.filter((s) => !seen.has(s.id))];
};

/**
 * The regions the regional OTT data actually holds services for — its own list, not
 * the Countries card's, so the Regional OTT cards follow the regional OTT labels.
 */
export const OTT_REGIONS = Object.entries(VERIFIED.regions)
  .filter(([, entry]) => entry.movie?.length || entry.tv?.length)
  .map(([name, entry]) => [name, String(entry.code || "").toUpperCase()])
  .sort((a, b) => a[0].localeCompare(b[0]));

/**
 * Every regional OTT service the facts hold — one entry per provider id, in name
 * order, each carrying the region it was verified in.
 *
 * This is what the Regional OTT cards publish: the regional OTT data itself
 * (78 services), not one country's slice of it (five rows). Two regions listing the
 * same service — Tubi TV is verified in more than one — is one row, scoped to a
 * region where it really resolves, so the catalog it opens is a real one rather than
 * an empty duplicate. Crunchyroll and Viki are not in the regional data (they are the
 * two Asian-catalogue services), so they are appended region-less and
 * `activeRegion()` scopes them per request.
 */
export const REGIONAL_SERVICES = (type) => {
  const byId = new Map();
  for (const entry of Object.values(VERIFIED.regions)) {
    for (const svc of entry[type] || []) {
      if (!byId.has(svc.id)) {
        byId.set(svc.id, { id: svc.id, name: svc.name, region: String(entry.code || "").toUpperCase() });
      }
    }
  }
  const list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set(list.map((s) => s.id));
  // **A regional row stays only while its country is on the Countries card.** The two
  // cards are the same fact read twice — "where titles come from" — so a service from a
  // country too thin to be a country row is not published as a service row either: it
  // was a route into the same near-empty list, under a brand name. The two worldwide
  // services carry no region and are kept (`codeHasContent` keeps an unknown code too,
  // so a region the country table does not list is not silently deleted).
  const kept = list.filter((svc) => codeHasContent(svc.region));
  const keptIds = new Set(kept.map((s) => s.id));
  return [...kept, ...WORLDWIDE.filter((s) => !seen.has(s.id) && !keptIds.has(s.id))];
};

/** The country the collection set is built for unless Settings picks another. */
export const DEFAULT_COUNTRY = (process.env.NUVIO_REGION || "US").toUpperCase();

/** Verified keyword ids, by card. */
const KW = VERIFIED.keywords;

/* entry builders — keep the list definitions short and consistent */

const preset = (name, value, take) => ({ name, kind: "preset", value, take });
const discover = (name, value, take) => ({ name, kind: "discover", value, take });
const curated = (name, params, take) => ({ name, kind: "curated", params, take });
const genre = (name, g, sort) => ({ name, kind: "genre", genre: g, sort });
const decade = (name, d, sort) => ({ name, kind: "decade", decade: d, sort });
const genreDecade = (name, g, from) => ({ name, kind: "genre-decade", genre: g, from });
const continent = (name, codes) => ({ name, kind: "continent", codes });
const country = (name, code, take) => ({ name, kind: "country", code, take });
// A **range**, not a floor: a bare `with_runtime.gte` made "30+ mins" and
// "180+ mins" both open on the same popular films, so every bucket looked like
// the last one. Each step ends where the next begins.
const runtime = (name, min, max) => ({ name, kind: "runtime", min, max });
// Episode buckets are disjoint ranges for the same reason — see `episodes` below.
const episodes = (name, min, max) => ({ name, kind: "episodes", min, max });
// **More like what you watch** — the row is built from TMDB's own recommendations
// for the titles in your Watchlist, resolved on the server (see `addon/catalogs.mjs`).
const recommend = (name) => ({ name, kind: "recommend" });
const keyword = (name, id, take) => ({ name, kind: "keyword", id, take });
// A **custom** row: served from the titles you put in it (`addon/customrows.mjs`),
// keyed by the row id so its contents survive a rename of its label.
const customRow = (name, row) => ({ name, kind: "custom", row });
const provider = (name, providerId, region, take) => ({ name, kind: "provider", providerId, region, take });
/** A platform's own studio's originals — a company, not a catalog of one. */
const original = (name, studio, take) => ({ name, kind: "original", studio: studio || null, take });

/**
 * The studio behind a platform's Originals rows, from `tmdb-verified.json`.
 *
 * `probe-originals.mjs` looks each platform's company up against TMDB and keeps
 * only candidates that really return titles, so a `<Platform> Originals` row is
 * never an empty invention.
 */
const ORIGINALS = VERIFIED.originals || {};
const watchlist = (name, state) => ({ name, kind: "watchlist", state });

/**
 * Keyword entries for one card, straight from the verified table.
 * Only labels that actually have titles for this row are published — otherwise
 * the row exists but always comes back empty.
 */
// Labels that live in the verified ``table but are *not* themes: **Documentary**
// is a genre, and **Anime** / **Asian Drama** are whole catalogues with their own
// **Genres** card. They are skipped wherever a theme list is built.
const KEYWORD_NOT_A_THEME = new Set(["Documentary", "Anime", "Asian Drama"]);

/**
 * The floor a keyword row must clear to be published.
 *
 * The verified table records how many titles each keyword actually returns. A few
 * labels clear zero and were already dropped; many more clear one or two, which is
 * what made **Moods & Vibes** read as "very less contents" — a card of names opening
 * onto a single title. Rows under this many titles are not published at all, so the
 * card holds fewer, fuller rows. **Awards** is exempt: its ceremonies are genuinely
 * small on TMDB, and the card is meant to name them.
 */
const MIN_KEYWORD_TITLES = 8;

const keywordEntries = (group, type, take) =>
  Object.entries(KW[group] ?? {})
    .filter(([name]) => !KEYWORD_NOT_A_THEME.has(name))
    .filter(([, k]) => (type === "movie" ? k.movieCount : k.tvCount) >= (group === "awards" ? 1 : MIN_KEYWORD_TITLES))
    .map(([name, k]) => keyword(name, k.id, take));

/**
 * Named keyword rows out of a group — for a card that publishes a few verified
 * labels rather than the whole group.
 */
const keywordPick = (group, names, type, take) =>
  names
    .filter((name) => KW[group]?.[name])
    .filter((name) => (type === "movie" ? KW[group][name].movieCount : KW[group][name].tvCount) > 0)
    .map((name) => keyword(name, KW[group][name].id, take));

/**
 * The rows the **Countries card** publishes: every country that clears the content floor
 * on this row (Ghana has films and no series, so it is a Movies row and not a Shows one).
 */
const countriesFor = (type) => COUNTRIES.filter(([name]) => countryHasContent(name, type));

/**
 * Global rows: Top 10, then everything — for the six `GLOBAL_OTT` platforms.
 *
 * Only the `| Top 10` rows are capped; the `all` rows are uncapped, because a
 * `take` of 30/40 made an OTT card the one place in the app whose rows stopped
 * after a couple of screens while every other card kept scrolling — the reported
 * "OTT cards don't scroll" bug.
 *
 * **The `Popular <platform>` card is gone.** It was the same six platforms read in
 * popularity order, one press away from the cards that already hold them, and it
 * was the card that kept coming back with the same handful of names.
 */
const globalOtt = {
  top10: (take) => GLOBAL_OTT.map(([label, id]) => provider(`${label} | Top 10`, id, null, take)),
  // Each platform, then that platform's own studio's originals — the row the
  // request asked for, directly after the platform's row.
  all: () =>
    GLOBAL_OTT.flatMap(([label, id]) => {
      const rows = [provider(label, id, null)];
      if (ORIGINALS[label]) rows.push(original(`${label} Originals`, ORIGINALS[label]));
      return rows;
    }),
};

/**
 * Regional OTT rows — **every country the Countries card publishes**.
 *
 * A card per region, driven by the Region setting, was one answer to "which services
 * are mine?" and it was the wrong shape: the Countries card already lists the
 * countries this build covers, so the Regional OTT card publishes **those countries'
 * own services**, each row scoped to the country it was verified in.
 *
 * Countries the regional data holds no services of their own for are skipped rather
 * than filled in with the worldwide pair again, so the card has one row per real
 * service instead of a hundred copies of the same two.
 */
function regionalOtt(kind) {
  const build = (type, media) => {
    const perCountry = [];
    const seen = new Set();
    for (const [name, code] of COUNTRIES) {
      if (!countryHasContent(name, type)) continue;
      const local = localFor(name, type);
      if (!local.length) continue;
      for (const svc of local) {
        // The same service can be listed for two countries (a pan-regional platform);
        // the region is part of the row's identity, so each one is its own row, and a
        // true duplicate of the same service *in the same region* is dropped.
        // **The region is an ISO code TMDB understands**, never the country's name —
        // `watch_region` takes the code, and a row carrying "JAPAN" would answer
        // nothing.
        const region = String(svc.region || code).toUpperCase();
        const key = `${svc.id}:${region}`;
        if (seen.has(key)) continue;
        seen.add(key);
        perCountry.push({ svc, code, region });
      }
    }
    // A service that appears in more than one country keeps its name and wears the
    // country beside it, so two rows can never read as the same one.
    const nameCount = new Map();
    for (const row of perCountry) nameCount.set(row.svc.name, (nameCount.get(row.svc.name) || 0) + 1);
    const rows = perCountry.map(({ svc, code, region }) => {
      const label = nameCount.get(svc.name) > 1 ? `${svc.name} · ${code}` : svc.name;
      return kind === "top10"
        ? provider(`${label} | Top 10`, svc.id, region, TOP10)
        : provider(label, svc.id, region);
    });
    // The worldwide pair (Crunchyroll, Viki) belong to every region, so they are added
    // once at the end rather than once per country.
    for (const svc of WORLDWIDE) {
      rows.push(kind === "top10"
        ? provider(`${svc.name} | Top 10`, svc.id, null, TOP10)
        : provider(svc.name, svc.id, null));
    }
    return rows;
  };
  return { movie: build("movie", "movie"), show: build("tv", "tv") };
}

const TOP10 = 10;
// **Discover Plus** publishes 25 titles per row rather than 10, so it is the one wide
// card that is worth scrolling. Its card key stays `discover-top-10` — that is the
// cover's filename (see the card's own entry for the name and its rows).
const TOP25 = 25;
const both = (list) => ({ movie: list, show: list.map((e) => ({ ...e })) });
const forBoth = (build) => ({ movie: build(MOVIE_GENRES), show: build(SHOW_GENRES) });

/**
 * `<Genre> ◆ 1950 → Present` rows for one row type.
 *
 * Only genres `tmdb-verified.json` recorded as returning titles from 1950 are
 * published, so the card can never contain a row that is always empty.
 */
const decadeGenres = (type, list) =>
  list
    .filter((g) => (VERIFIED.genreDecades?.[type]?.[g]?.count ?? 0) > 0)
    // **The row is named `Action | 1950 → Present`.** The separator is the vertical bar
    // every other composed name in the app wears (`Netflix | Top 10`); the glyph that
    // used to sit here was not in Inter and came out as a box on the covers.
    .map((g) => genreDecade(`${g} | 1950 → Present`, g, VERIFIED.genreDecades.from));

/**
 * The plain Discover card's five orders, unchanged: the newest, the most popular and
 * the best reviewed, in both directions of the date order. **Discover Plus** is the
 * card beside it that asks a different kind of question (see `discoverPlusRow`).
 */
const discoverRow = (suffix = "", take) => [
  discover(`Latest${suffix}`, "latest", take),
  discover(`Newest${suffix}`, "new", take),
  preset(`Trending${suffix}`, "trending", take),
  preset(`Popular${suffix}`, "popular", take),
  preset(`Top Rated${suffix}`, "top_rated", take),
];

/**
 * **Discover Plus** — the wide card, and every row in it is a verdict.
 *
 * The card used to be `Discover | Top 25`: the same five orders as the plain Discover
 * card (Latest, Newest, Trending, Popular, Top Rated) read a second time at twenty-five
 * titles instead of twenty. Two cards asking the same questions is one card too many —
 * and "Top 25" named the *length* of a row rather than why anything was in it, which is
 * what a card's name is for. It asks six different questions now: what is **Acclaimed**,
 * what this year's **Picks** are, what the **Hidden Gems** are, what has become a **Cult
 * Classic**, what the **Landmarks** everyone has seen are, and what is **Fresh**.
 *
 * Each row is one `curated` entry — a sort and the vote floor that makes it mean
 * something — so a row and the sentence describing it cannot drift apart. `within` is a
 * window in days and `before` a year; both are applied to the release date of the row's
 * own media type (see `specsFor` in `addon/catalogs.mjs`).
 */
const discoverPlusRow = (take) => [
  // The best reviewed titles with a real audience behind them: 2000 votes is a floor
  // that keeps a handful of 10s from topping the row.
  curated("Critically Acclaimed", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 2000 }, take),
  // This year and last: the same question as Acclaimed, asked of what is new — a floor
  // of 200 votes, because a title a month old has not had time to collect 2000.
  curated("Staff Picks", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 200, within: 540 }, take),
  // Well reviewed and barely seen — the ceiling is the point: a gem nobody has found
  // cannot have ten thousand votes.
  curated("Hidden Gems", { sort_by: "vote_average.desc", "vote_average.gte": 7, "vote_count.gte": 50, "vote_count.lte": 600 }, take),
  // Loved for long enough to be a classic, and made before the turn of the century.
  curated("Cult Classics", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 500, before: 2000 }, take),
  // The canon: the highest rated of the most seen, so the row is the titles everyone
  // already knows rather than the ones only a few do.
  curated("All-Time Landmarks", { sort_by: "vote_count.desc", "vote_average.gte": 7.8, "vote_count.gte": 5000 }, take),
  // Out now, and good — a low floor, because a title released this week has few votes.
  curated("Fresh This Week", { sort_by: "popularity.desc", "vote_average.gte": 6.5, "vote_count.gte": 20, within: 90 }, take),
];

/**
 * **The three period rows the Discover card opens on, at Top 10.**
 *
 * The Global and Regional Top 10 cards used to open straight onto one row per
 * service, which answered "what is on Netflix" before it answered "what is new
 * anywhere I can watch" — the question the card is named for. They open on the
 * same **Latest · Newest · Trending** set the Discover card carries, capped at
 * ten, and the service rows follow it.
 */
const top10Periods = (suffix = " | Top 10") => [
  discover(`Latest${suffix}`, "latest", TOP10),
  discover(`Newest${suffix}`, "new", TOP10),
  preset(`Trending${suffix}`, "trending", TOP10),
];

/**
 * The order Home shows the cards in — explicit, and the single source of truth.
 *
 * The array below is grouped the way the cards were written (all the OTT cards
 * together, all the keyword cards together); this list is what you actually see.
 * The app never reorders or subsets the cards, so the order is the same on every
 * device, in both the Movies and the Shows row, and in Nuvio itself.
 *
 * `based-on-the` sits directly after `runtimes`: the card order is the owner's
 * list, so "Based on the" belongs with the other shape-of-the-title cards (how
 * long it is, what it was made from) rather than down with the keyword cards.
 */
const CARD_ORDER = [
  "on-the-board",
  "for-you",
  "discover-top-10",
  "discover",
  "popular-by-genre",
  "top-rated-by-genre",
  // **Genres in or from decades sits in front of Genres.** The two are the same list
  // read two ways — every genre, and every genre since 1950 — so the narrower one
  // comes first and the plain list follows it, instead of being separated by the
  // decades cards.
  "genre-from-decades",
  "genres",
  "popular-by-decade",
  "top-rated-by-decade",
  "decades",
  "continental",
  "countries",
  "runtimes",
  "based-on-the",
  "moods-and-vibes",
  "themes-and-tags",
  "global-ott-top-10",
  "global-ott",
  "regional-ott-top-10",
  "regional-ott",
  // **Your own cards sit at the bottom, in the order you use them**: your list, then
  // what is on its way, then the rows you filled yourself. Watchlist was first for a
  // long time, which put a list that is usually short in front of the whole app.
  "watchlist",
  "upcoming",
  "custom",
];

/**
 * The whole card set for one country. The regional OTT cards are the only part
 * that depends on it, so this is what the addon rebuilds when the country in
 * Settings changes — a card names the catalogs inside it, and those names are
 * another country's services the moment the setting moves.
 */
const buildCollections = (code = "") => {
  // The array is written card-group by card-group; `CARD_ORDER` sets the order
  // Home shows them in. The three Watchlist rows are the states a pinned title
  // moves through, served from the stored pins rather than from TMDB; the row
  // after them is the custom one you fill yourself.
  return [
  {
    key: "watchlist",
    lines: ["Watchlist"],
    scene: "watchlist",
    // **Watching first**, then a horizontal rule, then Plan to Watch and Watched:
    // what you are on now sits above what is queued and what is finished, and the
    // rule is the boundary. `divider` rides on the entry, so the app draws the rule
    // before that one row on the card page.
    catalogs: both([
      watchlist("Watching", "watching"),
      { ...watchlist("Plan to Watch", "planned"), divider: true },
      watchlist("Watched", "watched"),
    ]),
  },
  {
    key: "for-you",
    lines: ["For", "You"],
    scene: "watchlist",
    // **More like what you watch**: one row drawn from TMDB's own recommendations
    // for the titles in your Watchlist — watched first, then watching, then planned.
    catalogs: both([recommend("More Like What You Watch")]),
  },
  {
    // **The key stays `discover-top-10`** — it is the cover's filename, and the card it
    // names is the wide one (twenty-five titles a row). The **name** is Discover Plus:
    // one card that asks six questions about the whole catalogue, beside the Discover
    // card that asks the five orders (see `discoverPlusRow`).
    key: "discover-top-10",
    lines: ["Discover", "Plus"],
    scene: "spotlight-top-10",
    catalogs: both(discoverPlusRow(TOP25)),
  },
  {
    key: "on-the-board",
    lines: ["On the", "Board"],
    scene: "on-the-board",
    // **Not a card on Home any more**: the hero banner already carries these rows
    // (Now Playing / On the Air) on its left-hand side, so the card is kept for the
    // banner to source but is not drawn in the grid.
    hidden: true,
    // **Airing This Week is gone from the banner.** It was a second "what is on now"
    // row beside On the Air, and on the banner it read as noise — what is on the air
    // already answers "what can I watch now?", and what is coming is the **Upcoming**
    // card's job (below).
    catalogs: {
      movie: [preset("Now Playing", "now_playing")],
      show: [
        preset("Airing Today", "airing_today"),
        preset("On the Air", "on_the_air"),
      ],
    },
  },
  {
    key: "upcoming",
    lines: ["Upcoming"],
    scene: "on-the-board",
    // **A window on what is coming, not a shelf of four.** The app draws this card as a
    // **spotlight**: its frame holds **one** still, and that still changes every ten
    // seconds the way the hero banner's does — the next few things to arrive, shown one
    // at a time. A wall of posters said nothing a row does not say better; one picture at
    // a time reads as "this is what is next".
    //
    // It is **not a door**: there is no button in the frame and clicking it goes
    // nowhere, because it is a glance at what is coming rather than a catalog to walk
    // through. It sits **between your Watchlist and your Custom row**, in the same row
    // as both, so the three of them are your own corner of the page.
    spotlight: true,
    // **What is on its way, under your own list.** One row per row type: what is
    // coming to cinemas, and what airs next — sorted by the date it arrives, so the
    // nearest thing is the first thing, not the most popular thing.
    // **Every country that has something on the way, not just Hollywood.** The card used
    // to be TMDB's own US-centric list (one row for films, one for shows), so what was
    // out next in Tokyo, Seoul, Mumbai or Lagos was nowhere on it. Each row below is one
    // of the big film industries read in **release-date order from today forward**, which
    // is what "upcoming" means, so the nearest arrival is the first thing on it.
    catalogs: both([
      preset("Upcoming", "upcoming"),
      curated("Upcoming in Japan", { with_origin_country: "JP", sort_by: "date.asc", future: 120 }),
      curated("Upcoming in Korea", { with_origin_country: "KR", sort_by: "date.asc", future: 120 }),
      curated("Upcoming in India", { with_origin_country: "IN", sort_by: "date.asc", future: 120 }),
      curated("Upcoming in France", { with_origin_country: "FR", sort_by: "date.asc", future: 120 }),
      curated("Upcoming in Nigeria", { with_origin_country: "NG", sort_by: "date.asc", future: 120 }),
      curated("Upcoming in China", { with_origin_country: "CN", sort_by: "date.asc", future: 120 }),
    ]),
  },
  {
    key: "discover",
    lines: ["Discover"],
    scene: "discover",
    catalogs: both(discoverRow()),
  },
  {
    key: "popular-by-genre",
    lines: ["Popular by", "◆ Genre"],
    scene: "popular-by-genre",
    // **Not a card on Home any more** (the same switch `on-the-board` uses). The entries
    // stay defined — the covers, the catalogue ids and the checks that name them are all
    // still true — they are simply not drawn in the grid.
    hidden: true,
    catalogs: forBoth((list) => list.map((g) => genre(`Popular in ${g}`, g, "popular"))),
  },
  {
    key: "genres",
    lines: ["Genres"],
    scene: "genres",
    // The genres, and only the genres. **Anime** and **Asian Drama** are keywords,
    // not genres, so they are not rows here either — they were never asked for as
    // a card, and they are not a genre row. The cards that genuinely hold that
    // content carry it already (Japan in Countries, Crunchyroll and Viki on the
    // OTT cards), and both stay out of Themes & Tags.
    catalogs: {
      movie: MOVIE_GENRES.map((g) => genre(g, g)),
      show: SHOW_GENRES.map((g) => genre(g, g)),
    },
  },
  {
    key: "top-rated-by-genre",
    lines: ["Top Rated", "◆ Genre"],
    // The cover generator paints one scene per `scene` name; a new card reuses an
    // existing painter rather than shipping with no artwork.
    scene: "popular-by-genre",
    hidden: true,
    catalogs: forBoth((list) => list.map((g) => genre(`Top Rated in ${g}`, g, "top_rated"))),
  },
  {
    key: "popular-by-decade",
    lines: ["Popular by", "◆ Decade"],
    scene: "popular-by-decade",
    hidden: true,
    catalogs: both(ALL_DECADES.map((d) => decade(`Popular in ${d}s`, d, "popular"))),
  },
  {
    key: "top-rated-by-decade",
    lines: ["Top Rated", "◆ Decade"],
    scene: "popular-by-decade",
    hidden: true,
    catalogs: both(ALL_DECADES.map((d) => decade(`Top Rated in ${d}s`, d, "top_rated"))),
  },
  {
    key: "decades",
    lines: ["Decades"],
    scene: "decades",
    catalogs: both(ALL_DECADES.map((d) => decade(`${d}s`, d))),
  },
  {
    key: "genre-from-decades",
    lines: ["Genre from", "Decades"],
    scene: "genres-in-or-from-decades",
    // Both rows. TV genres are a different set (no "Science Fiction", but
    // "Sci-Fi & Fantasy"), so each row uses its own verified list — and a
    // combination TMDB has no titles for is not published at all.
    catalogs: {
      movie: decadeGenres("movie", MOVIE_GENRES),
      show: decadeGenres("tv", SHOW_GENRES),
    },
  },

  // Global — the period rows, then Top 10 for each platform.
  {
    key: "global-ott-top-10",
    lines: ["Global", "| Top 10"],
    scene: "global-ott-top-10",
    catalogs: both([...top10Periods(), ...globalOtt.top10(TOP10)]),
  },
  {
    key: "global-ott",
    lines: ["Global"],
    scene: "global-ott",
    catalogs: both(globalOtt.all()),
  },

  // Regional OTT — **your region's** own services: Top 10, then the full list. The
  // rows are the regional OTT data itself, one per service, each scoped to the region
  // it was verified in, so a service verified for one market is still asked for that
  // market's titles. Covers stay title-only: drawing one service's name would be wrong
  // for a card that changes with the Region.
  {
    key: "regional-ott-top-10",
    lines: ["Regional", "| Top 10"],
    scene: "regional-ott-top-10",
    titleOnly: true,
    catalogs: {
      movie: [...top10Periods(), ...regionalOtt("top10").movie],
      show: [...top10Periods(), ...regionalOtt("top10").show],
    },
  },
  {
    key: "regional-ott",
    lines: ["Regional"],
    scene: "regional-ott",
    titleOnly: true,
    catalogs: regionalOtt("all"),
  },

  {
    key: "continental",
    lines: ["Continental"],
    scene: "continental",
    // **Every continent, with its thin countries dropped.** The continent is the row, and
    // a continent is a large enough query that no country list is needed to hold it up —
    // so the rows stay six and it is the codes inside each one that narrow.
    catalogs: both(continentsWithContent().map(([name, codes]) => continent(name, codes))),
  },
  {
    key: "countries",
    lines: ["Countries"],
    scene: "countries",
    catalogs: {
      movie: countriesFor("movie").map(([name, code]) => country(name, code)),
      show: countriesFor("show").map(([name, code]) => country(name, code)),
    },
  },
  {
    key: "runtimes",
    lines: ["Runtimes"],
    // Shows are not measured in minutes: on the Shows row the same card is its
    // episode-count ladder, so it says **Episodes** there.
    linesByRow: { show: ["Episodes"] },
    scene: "runtimes",
    // Movies: length buckets. Shows: episode-count buckets instead of runtime.
    catalogs: {
      // Longer ladders than the old three-step version: runtime is a real TMDB
      // filter, so every bucket is a row of its own.
      movie: [
        runtime("30–44 mins", 30, 44), runtime("45–59 mins", 45, 59),
        runtime("60–74 mins", 60, 74), runtime("75–89 mins", 75, 89),
        runtime("90–104 mins", 90, 104), runtime("105–119 mins", 105, 119),
        runtime("120–149 mins", 120, 149), runtime("150–179 mins", 150, 179),
        runtime("180+ mins", 180),
      ],
      // The ladder keeps climbing past a single season's worth: a 32- or 50-episode
      // show is common, and the long-running ones land in the buckets beyond 50.
      show: [
        episodes("4 Episodes", 1, 4), episodes("6 Episodes", 5, 6),
        episodes("8 Episodes", 7, 8), episodes("10 Episodes", 9, 10),
        episodes("12 Episodes", 11, 12), episodes("16 Episodes", 13, 16),
        episodes("20 Episodes", 17, 20), episodes("24 Episodes", 21, 24),
        episodes("28 Episodes", 25, 28), episodes("32 Episodes", 29, 32),
        episodes("40 Episodes", 33, 40), episodes("50 Episodes", 41, 50),
        episodes("60 Episodes", 51, 60), episodes("80 Episodes", 61, 80),
        episodes("100+ Episodes", 81),
      ],
    },
  },

  {
    key: "based-on-the",
    lines: ["Based", "on the"],
    scene: "based-on-the",
    catalogs: { movie: keywordEntries("based-on-the", "movie"), show: keywordEntries("based-on-the", "show") },
  },
  {
    key: "moods-and-vibes",
    lines: ["Moods", "& Vibes"],
    scene: "moods-and-vibes",
    catalogs: { movie: keywordEntries("moods-and-vibes", "movie"), show: keywordEntries("moods-and-vibes", "show") },
  },
  {
    key: "themes-and-tags",
    lines: ["Themes", "& Tags"],
    scene: "themes-and-tags",
    catalogs: { movie: keywordEntries("themes-and-tags", "movie"), show: keywordEntries("themes-and-tags", "show") },
  },
  // The **Custom** card: your own list. Its label is a setting (`customLabel`),
  // applied where the cards are served, so this card's name is whatever you called
  // it and its row is filled from `addon/customrows.json`.
  {
    key: "custom",
    lines: ["Library"],
    scene: "on-the-board",
    // **Six row slots, named per request.** The card's rows come from
    // `addon/customrows.mjs` (Settings → Custom Rows adds, renames, deletes and orders
    // them); the slots are declared here so every row has a stable catalog id, and the
    // payload keeps only the ones that exist and names them what the user called them.
    catalogs: {
      movie: Array.from({ length: 6 }, (_, i) => customRow("My List", i === 0 ? "add-cards" : `add-cards-${i + 1}`)),
      show: Array.from({ length: 6 }, (_, i) => customRow("My List", i === 0 ? "add-cards" : `add-cards-${i + 1}`)),
    },
  },
  ];
};

/**
 * In the published order, with the vertical divider after Watchlist.
 *
 * The divider is a property of the card it sits *before* (the grid draws one when
 * it reaches a card that carries the flag), so it is attached to whatever follows
 * the Watchlist rather than hard-coded on one card that could be reordered away
 * from it. A card the order list does not mention keeps its place at the end
 * instead of vanishing.
 */
const ordered = (cards) => {
  const rank = (c) => {
    const i = CARD_ORDER.indexOf(c.key);
    return i === -1 ? CARD_ORDER.length : i;
  };
  const sorted = [...cards].sort((a, b) => rank(a) - rank(b));
  // The rule sits before the **first card after Watchlist that Home actually
  // draws**: a hidden card (the banner's own source) cannot carry it, or the rule
  // would disappear along with the card it was attached to. Watchlist is no longer
  // first, so the rule is asked for relative to *its* place rather than to the top.
  const watch = sorted.findIndex((c) => c.key === "watchlist");
  const firstDrawn = sorted.findIndex((c, i) => i > (watch === -1 ? 0 : watch) && !c.hidden);
  return sorted.map((c, i) => ({ ...c, divider: i === firstDrawn }));
};

const buildCollectionsOrdered = (code = "") => ordered(buildCollections(code));

/** The card set, in the published order. */
export const COLLECTIONS = buildCollectionsOrdered();

/**
 * The card set, in the published order, **for one region**.
 *
 * The Regional OTT cards are what the region chooses: their rows are that region's
 * own services (see `regionalOtt`), so the set is rebuilt per country rather than
 * built once — which is also why the addon keys its defs cache by country. Every
 * other card is the same in every region, and a row with no region of its own is
 * still scoped per request by `activeRegion()` in `addon/catalogs.mjs`.
 */
export const collectionsFor = (code = "") => buildCollectionsOrdered(String(code || "").toUpperCase());

/**
 * A card's name, **for one row** where the two differ.
 *
 * The Runtimes card is about minutes on Movies and about episode counts on Shows,
 * so it wears a different name on each row (`linesByRow`) instead of one title that
 * is only true half the time. Every other card falls back to its `lines`.
 */
export const title = (cat, row) => (cat.linesByRow?.[row] ?? cat.lines).join(" ");

/** The catalog entries inside a card for one row ("movie" | "show"). */
export const catalogEntries = (cat, row) => {
  const c = cat.catalogs;
  if (!c) return [];
  const list = Array.isArray(c) ? c : c[row];
  return Array.isArray(list) ? list : [];
};

/** The catalog names inside a card for one row — what the cover shows. */
export const catalogLabels = (cat, row) => catalogEntries(cat, row).map((e) => e.name);

/**
 * The verified keyword rows of a group as `[label, id]` — the vocabulary the
 * search panel's Mood and Theme filters are built from, so those rows offer the
 * same names the cards do and never a keyword TMDB does not have.
 */
export const keywordVocab = (group) =>
  Object.entries(KW[group] ?? {})
    .filter(([name]) => !KEYWORD_NOT_A_THEME.has(name))
    .map(([name, k]) => [name, k.id]);

/**
 * Every country that really has titles, as `[code, name]` — the search panel's
 * Country filter. A territory with nothing in it is not offered, so choosing one
 * can never produce an empty screen.
 */
export const countryVocab = () =>
  COUNTRIES.filter(([name]) => countryHasContent(name, "movie") || countryHasContent(name, "show")).map(
    ([name, code]) => [code, name],
  );

/**
 * The card the vertical divider is drawn before, in the published order.
 *
 * It is not a constant any more: the rule belongs to the **first card after your
 * Watchlist**, so it follows the Watchlist when the order moves — which is exactly
 * what happened when your list went to the bottom of the page. Derived from
 * `COLLECTIONS`, so it cannot drift from the flag the app actually reads.
 */
export const DIVIDER_BEFORE = COLLECTIONS.find((c) => c.divider)?.key ?? "";

/** The subtitle string drawn on the cover (empty for a title-only card). */
export const subtitleOf = (cat, row) => (cat.titleOnly ? "" : catalogLabels(cat, row).join(" · "));
