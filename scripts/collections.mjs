/**
 * The AutoCAT collection set — single source of truth.
 *
 * Shared by the cover generator (`scripts/generate-covers.mjs`) and the catalog
 * addon (`addon/catalogs.mjs`), so the cover art and the catalog rows can never
 * drift apart. Order matters: it is the row order in the AutoCAT home screen.
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
 *                 plus `within` (days), `before` (year), `olderThan` (days),
 *                 `between` (two ISO days: from and to), `future` (days: the
 *                 window's far end) and `after` (days: its near end) — all turned
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
 *   is left off, because a capped row is a row that stops scrolling: the cap
 *   belongs to the card's wall, and an Explore page reads every row to the end
 *   (see `deep` in `catalogMetas`).
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
  "Latin America": ["BR", "AR", "CO", "CL", "PE"],
  Africa: ["NG", "ZA", "EG", "KE", "MA", "GH"],
  "Middle East": ["AE", "SA", "IL", "TR", "QA", "KW", "BH", "OM", "JO", "LB"],
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
 * **The Asian rows are published, and the duplicate is removed by name.**
 *
 * They were briefly cut from both Regional cards, on the reading that Crunchyroll, Rakuten
 * Viki and Kocowa — carried by every card — already hold the Asian catalogue. They do not:
 * a regional row is read in the **provider's own region**, so `WeTV`, `Viu`, `iQIYI`,
 * `TVING`, `Zee5`, `aha` and the rest open catalogues the three never carry, and the cut took
 * most of a continent off the card. So the rows are back, on the region's own card, on the
 * continent rows, and in the live list the per-request build tops the card up from.
 *
 * The duplicate the cut was really about is still gone — `Crunchyroll` sat on the card twice,
 * once per region's provider id. That is `oneRowPerService`'s job now: **the brand is the
 * identity**, and the first row for a name wins.
 */

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
export const LOCAL_LIMIT = 12;
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
        byId.set(svc.id, { id: svc.id, name: brandOf(svc.name), region: String(entry.code || "").toUpperCase() });
      }
    }
  }
  // **One row per service here too**, by name: this is the list the live build tops the card
  // up from, and a platform TMDB numbers twice for two regions came back twice (see
  // `oneRowPerService`). The name is the identity; the first region it was seen in wins.
  const list = [...new Map([...byId.values()].map((svc) => [popKey(svc.name) || svc.id, svc])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set(list.map((s) => s.id));
  // **A regional row stays only while its country is on the Countries card.** The two
  // cards are the same fact read twice — "where titles come from" — so a service from a
  // country too thin to be a country row is not published as a service row either: it
  // was a route into the same near-empty list, under a brand name. The two worldwide
  // services carry no region and are kept (`codeHasContent` keeps an unknown code too,
  // so a region the country table does not list is not silently deleted).
  const kept = list.filter((svc) => codeHasContent(svc.region) && isPopularRegional(svc.name) && rowFillsAPage(svc.id, svc.region, type));
  const keptIds = new Set(kept.map((s) => s.id));
  return [...kept, ...WORLDWIDE.filter((s) => !seen.has(s.id) && !keptIds.has(s.id))];
};

/**
 * **Only the services people actually subscribe to.**
 *
 * The regional data holds 133 services, and the card published every one of them: a
 * Regional OTT row was as likely to be a small national catalogue, a shop-front for a
 * broadcaster's back catalogue, or a companion app for a pay-TV box as it was to be a
 * service anyone recognises — and two of them were literally named \`5\` and \`10\`, the
 * provider list's own abbreviations, sitting in the card as rows called "5" and "10".
 *
 * So the card keeps the **household names**: the streaming service of each region's
 * broadcasters, the big local platforms, and the regional players everyone in that
 * country would name if asked. Everything else — the Amazon/Apple/Roku *channel*
 * variants, the box companions, the art-house catalogues, the two numeric labels — is
 * left out of the card. The data still holds them; this is the card's own list.
 */
const POPULAR_REGIONAL = new Set([
  // —— the Pacific
  "9Now", "Stan", "BINGE", "SBS On Demand", "ABC iview", "7plus", "10 play", "TVNZ+", "ThreeNow",
  "Neon", "Foxtel Now", "Kayo Sports", "Optus Sport", "Sky Sport Now",
  // —— Britain and Ireland
  "BBC iPlayer", "ITVX", "Channel 4", "My5", "All 4", "Channel 5", "BritBox", "STV Player",
  "Virgin Media Play", "NOW",
  // —— South Asia
  "JioHotstar", "Zee5", "MX Player", "aha", "Sun Nxt", "Sun NXT", "Sony Liv", "SonyLIV",
  "Hoichoi", "JioCinema", "Eros Now", "Lionsgate Play",
  // —— Korea and Japan
  "TVING", "wavve", "Watcha", "Coupang Play", "U-NEXT", "Hulu", "ABEMA", "AbemaTV",
  "Lemino", "TVer", "FOD", "WOWOW", "DMM TV", "d Anime Store",
  // —— Greater China and South-East Asia
  "iQIYI", "WeTV", "Viu", "Vidio", "Catchplay", "Mewatch", "Tencent Video", "Youku",
  "Mango TV", "Bilibili", "myTV SUPER", "TrueID", "sooka", "Astro GO", "Vision+",
  // —— continental Europe. The broadcasters' own services first, then the pay platforms,
  // then the markets that have their own catalogue in one country only.
  "ZDF", "ARD Mediathek", "RTL+", "Joyn", "ORF ON", "Sky", "Canal+", "M6+", "Molotov",
  "Movistar Plus+", "Atresplayer", "Filmin", "rtve", "RTVE Play", "Mediaset Infinity",
  "RaiPlay", "Rai Play", "Videoland", "NPO Start", "Viaplay", "TV4 Play", "SVT Play",
  "C More", "NRK TV", "TV 2 Play", "DR TV", "Yle Areena", "TVP", "TVP VOD", "Player",
  "Polsat Box Go", "SkyShowtime", "France TV", "OCS",
  // —— Türkiye and Russia
  "Exxen", "Gain", "BluTV", "Kinopoisk", "Okko", "Wink", "START", "Ivi",
  "Premier",
  // —— the Middle East. **The region's own platforms, and only those.** The worldwide
  // services (Netflix, Prime Video, HBO Max, Apple TV+) were on this list once and did not
  // belong on it: they have their own card (see `GLOBAL_OTT`), and a Regional OTT row for
  // one of them says the region has a service of its own that it does not.
  "Shahid VIP", "OSN+", "STARZPLAY", "MBC+", "TOD", "Jawwy TV", "stc tv",
  "yes+", "Partner", "Hot", "WATCH IT", "Yango Play", "Weyyak",
  // —— Africa
  "Showmax", "DStv Stream", "SABC+", "IROKOTV",
  // —— the Americas
  "Globoplay", "Telecine", "Claro tv+", "Vivo Play", "PlayPlus", "Flow", "DGO",
  "VIX", "ViX Premium", "Claro video", "Cin\u00e9polis KLIC", "Star+",
  // **Not Paramount Plus.** It is one of the six platforms the Global OTT card owns, and the
  // same rule that keeps Netflix, Prime Video and HBO Max off this card keeps it off too.
  "Crave", "CBC Gem", "ICI TOU.TV EXTRA",
  // —— **the household names the list was missing.** The card is built by *asking TMDB* which
  // services a country really carries, and this list is what decides which of them the card's
  // Popular prefix is made of. The names below are the ones people actually name in their
  // country — the US's Peacock and Kocowa, India's SonyLIV and JioCinema, the Korean and
  // Japanese catalogues, the Greater-China and SEA platforms, the broadcasters' own players in
  // Britain and Europe — and each was missing, which is why the card could show fourteen rows
  // and none of them the service the viewer was looking for.
  // **The household names, and only those.** A regional OTT card is what someone in that part
  // of the world would name if asked; the small national catalogues, the single-broadcaster
  // apps and the box companions are left to the data, not published as rows. (puhutv, Mitele,
  // 3Cat, Kijk, Vivamax, Blim, Tonton, Mola TV, RCTI+, Hami Video and the rest of the long tail
  // were in this list for one pass and are out again: nobody names them, and a card of them was
  // the complaint.)
  "Peacock", "Peacock Premium", "Pluto TV", "Tubi", "Tubi TV", "Starz", "AMC+", "AMC Plus",
  "MGM+", "MGM Plus", "FuboTV", "fuboTV", "Shudder", "Kocowa", "Rakuten Viki",
  // **The documentary and art-house streamers.** TMDB carries each of these as a regional
  // service and the report names them as regional OTT, so they are on the card like the
  // rest — verified in a region that really returns titles (see the Japan roster).
  "Curiosity Stream", "DOCSVILLE", "MUBI", "Discovery+",
  "JioCinema", "Voot", "Lionsgate Play", "Eros Now", "Sun NXT", "Watcha", "AbemaTV", "TVer",
  "7plus", "10 play",
  "ABC iview", "Channel 5", "My5", "All 4", "STV Player", "RTE Player", "Virgin Media Play",
  "Arte", "Sky Go", "WOW", "TIMvision", "Canal+ Online", "OSN", "HOT VOD",
  "Partner TV", "DStv Now",
]);

/**
 * **A name as one key.** TMDB spells a brand its own way — `SonyLIV` where the card says
 * `Sony Liv`, `Rakuten Viki` where it says `Viki`, `aha` where it says `Aha` — and the list
 * above was compared letter for letter, so the service was in the data, on the region's list,
 * and still not recognised as one of the names a viewer would know. Case, spaces, dots and
 * hyphens are dropped on both sides now, which is the whole of the difference between the two
 * spellings of one service.
 */
const popKey = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9+]/g, "");

/** The list above, as keys, so the comparison never depends on how a name is punctuated. */
/**
 * **The owner's own region-by-region list.** Every service in it is treated the way the
 * household names above are: a row is published for it wherever the region's own data (or
 * TMDB's answer for the country) verifies it, and a row that cannot fill a page is still
 * culled. It is a **second list rather than a longer one** so the two can be told apart later
 * — what the owner asked for by name, and what the cards were built with.
 */
const OWNER_REGIONAL = [
  "JioHotstar",
  "SonyLIV",
  "ZEE5",
  "Sun NXT",
  "Hoichoi",
  "Aha",
  "ManoramaMAX",
  "aha Tamil",
  "Planet Marathi OTT",
  "Chaupal",
  "Stage",
  "ShemarooMe",
  "Ultra Jhakaas",
  "Addatimes",
  "NammaFlix",
  "ETV Win",
  "Simply South",
  "iStream",
  "Hungama Play",
  "U-NEXT",
  "ABEMA",
  "Lemino",
  "d Anime Store",
  "FOD",
  "Hulu Japan",
  "DMM TV",
  "WOWOW On Demand",
  "TELASA",
  "TVer",
  "Niconico",
  "Bandai Channel",
  "Crunchyroll",
  "TVING",
  "Wavve",
  "WATCHA",
  "Coupang Play",
  "Laftel",
  "KOCOWA+",
  "Kocowa",
  "OnDemandKorea",
  "iQIYI",
  "Youku",
  "Tencent Video",
  "Mango TV",
  "Bilibili",
  "Sohu Video",
  "Migu Video",
  "friDay Video",
  "LINE TV",
  "KKTV",
  "MyVideo",
  "Catchplay+",
  "Hami Video",
  "Viu",
  "myTV SUPER",
  "Now TV",
  "HOY",
  "TVB Anywhere",
  "Vidio",
  "Vision+",
  "RCTI+",
  "MAXstream",
  "Genflix",
  "TrueID",
  "AIS PLAY",
  "MONOMAX",
  "meWATCH",
  "Viddsee",
  "Tonton",
  "sooka",
  "Astro GO",
  "dimsum",
  "iWantTFC",
  "Vivamax",
  "Cignal Play",
  "Pilipinas Live",
  "Rakuten Viki",
  "GagaOOLala",
  "BBC iPlayer",
  "ITVX",
  "Channel 4",
  "My5",
  "BritBox",
  "NOW",
  "Sky Go",
  "STV Player",
  "S4C Clic",
  "france.tv",
  "France TV",
  "Canal+",
  "ARTE",
  "Arte",
  "TF1+",
  "M6+",
  "Molotov",
  "OCS",
  "ARD Mediathek",
  "ZDF",
  "RTL+",
  "Joyn",
  "WOW",
  "MagentaTV",
  "Videoload",
  "RTVE Play",
  "rtve",
  "Atresplayer",
  "Mitele",
  "Movistar Plus+",
  "Filmin",
  "RaiPlay",
  "Rai Play",
  "Mediaset Infinity",
  "TIMVISION",
  "Infinity+",
  "Viaplay",
  "SVT Play",
  "NRK TV",
  "Yle Areena",
  "DR TV",
  "TV 2 Play",
  "C More",
  "TVP",
  "TVP VOD",
  "Player",
  "Player.pl",
  "Polsat Box Go",
  "Canal+ Online",
  "RTP Play",
  "OPTO SIC",
  "TVI Player",
  "NPO Start",
  "Videoland",
  "NLZIET",
  "VRT MAX",
  "GoPlay",
  "Streamz",
  "Voyo",
  "JOJ Play",
  "iVysílání",
  "prima+",
  "Sweet.tv",
  "Megogo",
  "AntenaPLAY",
  "tabii",
  "GAİN",
  "Gain",
  "Exxen",
  "puhutv",
  "BluTV",
  "Hulu",
  "Peacock",
  "Peacock Premium",
  "Tubi",
  "Pluto TV",
  "PBS",
  "The Roku Channel",
  "AMC+",
  "AMC Plus",
  "BET+",
  "ALLBLK",
  "MUBI",
  "HIDIVE",
  "HiDive",
  "Hallmark+",
  "Acorn TV",
  "MHz Choice",
  "Dropout",
  "CBC Gem",
  "Crave",
  "CTV",
  "Global TV",
  "ICI TOU.TV",
  "ICI TOU.TV EXTRA",
  "Club Illico",
  "illico+",
  "Knowledge Network",
  "APTN lumi",
  "OUTtv",
  "VIX",
  "ViX Premium",
  "Claro video",
  "Blim TV",
  "Canela.TV",
  "Cinepolis KLIC",
  "Cinépolis KLIC",
  "Flow",
  "Globoplay",
  "Vivo Play",
  "Looke",
  "Itaú Cultural Play",
  "Sesc Digital",
  "Oldflix",
  "Reserva Imovision",
  "Cine.ar Play",
  "Cont.ar",
  "Movistar TV",
  "Caracol Play",
  "RTVCPlay",
  "CNTV Play",
  "TVN Play",
  "Zapping",
  "América tvGO",
  "TVPerú Play",
  "Antel TV",
  "Vera TV",
  "Shahid",
  "Shahid VIP",
  "STARZPLAY",
  "OSN+",
  "OSN",
  "TOD",
  "ADtv",
  "Dubai+",
  "Awaan",
  "Jawwy TV",
  "WATCH IT",
  "Filimo",
  "Namava",
  "Telewebion",
  "mako",
  "NEXT TV",
  "Cellcom TV",
  "yes+",
  "HOT VOD",
  "Roya TV",
  "Shofha",
  "WatanFlix",
  "Yango Play",
  "Showmax",
  "DStv Stream",
  "DStv Now",
  "StarTimes ON",
  "Canal+ Afrique",
  "AzamTV Max",
  "SABC+",
  "eVOD",
  "TelkomONE",
  "IROKOtv",
  "IROKOTV",
  "Akwaaba Magic",
  "Maisha Magic",
  "TV5MONDEplus",
  "ABC iview",
  "SBS On Demand",
  "Stan",
  "BINGE",
  "7plus",
  "9Now",
  "10 play",
  "Kayo Sports",
  "Foxtel Now",
  "DocPlay",
  "Beamafilm",
  "TVNZ+",
  "ThreeNow",
  "Māori+",
  "NZ On Screen",
  "Neon",
  "Criterion Channel",
  "The Criterion Channel",
  "Curiosity Stream",
  "CuriosityStream",
  "DOCSVILLE",
  "Docsville",
  "Shudder",
  "Screambox",
  "MagellanTV",
  "Magellan TV",
  "Discovery+",
  "Discovery Plus",
  "Nebula",
  "Gaia",
  "BroadwayHD",
  "StagePlayer+",
  "NFB",
  "ONF",
  "OVID.tv",
  "OVID",
  "MasterClass",
  "GagaOOLala",
  "Dropout",
  "ALLBLK",
  "Hallmark Movies Now",
  "Acorn TV",
  "MHz Choice",
];

const POPULAR_REGIONAL_KEYS = new Set([...POPULAR_REGIONAL, ...OWNER_REGIONAL].map(popKey));

/** Is this a service the Regional OTT card publishes? (@see `regionalServicesFor` in addon/catalogs.mjs) */
export const isPopularRegional = (name) => POPULAR_REGIONAL_KEYS.has(popKey(name));

/**
 * **The Specialist card's own list: the art-house, documentary and niche catalogues.**
 *
 * They are the services the Regional card deliberately leaves out — "the Amazon/Apple/Roku
 * *channel* variants, the box companions, the **art-house catalogues**" — and they are a card
 * of their own now: the places a viewer goes *on purpose*, rather than the ones a country's
 * subscription list happens to lead with. MUBI and the Criterion Channel for the canon,
 * Shudder and Cultpix for horror, Curiosity Stream, DOCSVILLE and MagellanTV for
 * documentaries, MHz Choice for subtitled drama, Kanopy beside them.
 *
 * The names are compared the way the household list is (`popKey`), because TMDB spells a
 * brand its own way — `The Criterion Channel` where the card says `Criterion Channel`.
 *
 * The **card has no rows of its own**: every row it publishes is one of these services as
 * TMDB lists it for *your* region, added at request time (see `withSpecialistServices` in
 * `addon/catalogs.mjs`) — so an id is never guessed here, and a service your region does not
 * carry never gets a row.
 */
const SPECIALIST_SERVICES = new Set([
  // —— **the owner's specialist list, all of it.** The first pass carried only the eight
  // names from one message and the owner's reply was "did you forget others I sent?" — the
  // list they sent has twenty-six brands, and it is the card. This is the whole roster: the
  // art-house, documentary, horror, anime and niche catalogues, added with the spellings TMDB
  // uses as well as the owner's (`DOCSVILLE`/`Docsville`, `Magellan TV`/`MagellanTV`,
  // `Rakuten Viki`/`Viki`) because `popKey` folds the punctuation, not the words.
  //
  // **A name here is a claim, not a row.** A row is published only where TMDB actually lists
  // the service (your region's list, the United States' list, or the verified roster — see
  // `specialistServices` in `addon/catalogs.mjs`), so a brand nobody carries adds nothing to
  // the card and costs one filter comparison.
  // —— horror
  "Shudder", "Screambox",
  // —— art-house, classic and cult cinema (the owner's later additions included)
  "Criterion Channel", "The Criterion Channel", "MUBI", "OVID.tv", "Ovid",
  "RetroCrush", "AsianCrush", "Hi-YAH!", "Hi-YAH", "Midnight Pulp", "Film Movement Plus",
  "Film Movement", "Chai Flicks", "Shout! Factory TV", "Shout Factory TV", "Cineverse",
  "NFB", "NFB/ONF", "ONF", "Fandor", "Kanopy", "DocAlliance", "GuideDoc", "Dekkoo",
  "Cultpix", "True Story",
  // —— documentary
  "Curiosity Stream", "CuriosityStream",
  "DOCSVILLE", "Docsville",
  "MagellanTV", "Magellan TV",
  "Gaia", "DocPlay", "Beamafilm",
  // —— anime and Asian drama
  "Crunchyroll", "HIDIVE", "HiDive", "KOCOWA+", "Kocowa", "Rakuten Viki", "Viki",
  "GagaOOLala", "OnDemandKorea", "OnDemandChina", "Laftel", "WATCHA", "Eros Now", "iQIYI",
  // —— British and international drama
  "Acorn TV", "BritBox", "MHz Choice", "BritBox Amazon Channel",
  // —— Black television and film
  "ALLBLK", "BET+", "BET Plus",
  // —— romance and family
  "Hallmark+", "Hallmark Movies Now", "Hallmark Channel",
  // —— comedy and improv
  "Dropout",
  // —— learning
  "MasterClass", "Nebula", "CuriosityStream TV",
  "Discovery+", "Discovery Plus",
  // —— theatre and the performing arts
  "BroadwayHD", "StagePlayer+", "Stage Player", "Marquee TV",
]);

/** The same list, as keys — see `popKey`. */
const SPECIALIST_KEYS = new Set([...SPECIALIST_SERVICES].map(popKey));

/** Is this a service the Specialist card publishes? (@see `withSpecialistServices` in addon/catalogs.mjs) */
export const isSpecialistService = (name) => SPECIALIST_KEYS.has(popKey(name));

/**
 * **A service on the Specialist card is not a row on the Domestic card.**
 *
 * The owner asked for it in one line — *"if they are specialist, take them off Domestic"* — and
 * the two cards were carrying the same brands (Shudder, Criterion, Curiosity Stream, DOCSVILLE,
 * Magellan TV, Discovery+, Crunchyroll, Viki, BritBox, Acorn…): the same row twice, on a card
 * about *your country's* services and on the card about the niche catalogues. One service, one
 * card; the Specialist card is where they live now, and it reads each of them in the country
 * that actually carries it.
 */
export const offTheDomesticCard = (name) => isSpecialistService(name);

/**
 * **A row that cannot fill a page is not a row.**
 *
 * The floor under a Regional OTT row, in the region the row is read in. The customer asked
 * twice for it: *"mediaset infinity and exxen and IROKOTV not showing content in shows"* and
 * then *"remove those regional ott which has very few catalog from movie and shows regional
 * card"* — and the second ask names the shape of the fix. TMDB holds a great many regional
 * services that answer six titles, one title or none at all, and a row of six under a brand
 * name is a row that opens onto nothing.
 *
 * The counts are **measured, not guessed**: `scripts/probe-regional.mjs` asks TMDB the same
 * question the live catalog asks (the row's own region, flatrate, 10+ votes) for every row the
 * cards publish, and writes `regional-counts.json`. **25** is where the measurements break:
 * across all 188 measured (row, type) pairs the sequence runs 0, 8, 11, 13, 13, 13, 16, 17, 20,
 * 21, 24 — then **27** — and nothing in between, so 25 is the widest possible cut. Discovery+,
 * the thinnest row that stays, answers 27 films in the United States.
 *
 * A row with **no measurement** is kept (`miss` and a probe that failed on a slot both mean
 * "not asked", and an unasked question is not a no — the same rule the region provider lists
 * follow). A row is judged **per row type**: MUBI keeps its 264 films and loses its 0 series,
 * iQIYI keeps 56 series and loses its 11 films.
 */
const REGIONAL_COUNTS = (() => {
  try {
    return require("./regional-counts.json").counts || {};
  } catch {
    // No measurements on disk: nothing is culled, which is the state this card was in before.
    return {};
  }
})();
const COUNT_FALLBACK_REGION = "US";
export const MIN_REGIONAL_TITLES = 25;

/**
 * **A service is one row, so one measurement answers for it.**
 *
 * The counts are keyed `provider@region` — the region the row is read in — and a service is
 * measured once (the probe walks one row per service). The card can still reach the same
 * service from a second source: the continent rows (`regionalOttByContinent`) carry the country
 * code of the list that contributed them, which is how iQIYI came back after its region row was
 * culled — read in Morocco by the continent pass, judged by nothing, and drawn with its six
 * films. So the lookup falls back to the provider's own measurement wherever it was taken: the
 * row is the service, and the service is thin or it is not.
 */
const REGIONAL_COUNTS_BY_ID = (() => {
  const byId = new Map();
  for (const [slot, held] of Object.entries(REGIONAL_COUNTS)) {
    const id = slot.split("@")[0];
    if (id && !byId.has(id)) byId.set(id, held);
  }
  return byId;
})();

/** What TMDB answered for one provider, or `null` when it was never asked. */
export const regionalTitles = (providerId, region, type) => {
  const id = String(providerId);
  const held = REGIONAL_COUNTS[`${id}@${String(region || COUNT_FALLBACK_REGION).toUpperCase()}`]
    || REGIONAL_COUNTS_BY_ID.get(id);
  if (!held) return null;
  const n = Number(type === "tv" ? held.tv : held.movie);
  // `-1` is a probe that failed, not a row that answered nothing.
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Is this row big enough to publish, on this row type?
 *
 * Exported because the live catalog build (`withRegionalServices`) tops the cards up from
 * TMDB's own list for the region in Settings, and a row culled here would otherwise be added
 * straight back by that pass.
 */
export const rowFillsAPage = (providerId, region, type) => {
  const n = regionalTitles(providerId, region, type);
  return n === null || n >= MIN_REGIONAL_TITLES;
};

/**
 * **The services the Shows card does not publish.**
 *
 * The three documentary streamers are verified in Japan and are real rows on the films card.
 * The customer asked them off the **shows** side, where their catalogues are not what anyone
 * opens a Regional OTT card for — and off it means off it: the row is dropped for the series
 * row type in the region's own list **and** on the continent rows, which are the same data
 * read wider (see `regionalOtt` and `regionalOttByContinent`).
 *
 * **Seven rows, and each one was measured.** Sun Nxt, aha and Hoichoi were asked off by name.
 * Mediaset Infinity, Exxen and IROKOTV were reported as "not showing content" on the shows
 * side, and TMDB says that is the truth of it: asked with the row's own region and its own
 * monetisation (flatrate, 10+ votes), Mediaset Infinity answers **6** series in Italy, Exxen
 * **1** in Türkiye and IROKOTV **0** in Nigeria, while the shows card's rows run into the
 * hundreds. A row that cannot fill a page is not a row; each of the three keeps its place on
 * the **films** card, where the same probe answers 117, 0 and 97 titles. (Exxen's films row is
 * empty too — it is kept for now because it was not the row that was reported; say the word
 * and it goes off both cards.)
 */
const SHOW_ROW_OFF = new Set([
  "DOCSVILLE", "MUBI", "Curiosity Stream",
  "Sun Nxt", "Sun NXT", "aha", "Hoichoi",
  "Mediaset Infinity", "Exxen", "IROKOTV",
]);
const offTheShowsCard = (type, name) => type === "tv" && SHOW_ROW_OFF.has(String(name || "").trim());

/**
 * **Every row keeps the place it was published in.**
 *
 * There was a placement map here: Crunchyroll was pulled up beside FOD and Kocowa was put
 * directly after Rakuten Viki. It is empty again, as asked — a service moved out of the order
 * its own region was read in makes the card look like it has favourites, and Crunchyroll, Viki
 * and Kocowa are ordinary rows of the regions that carry them. `placeRowsAfter` stays: it is
 * the one place a placement would be written, and with nothing in the map it hands the list
 * back untouched.
 */
const ROW_AFTER = {};
const rowLabel = (row) => String(row?.name || "").replace(/ \| Top 10$/, "");

function placeRowsAfter(rows, after = ROW_AFTER) {
  let out = rows;
  for (const [name, anchor] of Object.entries(after)) {
    const row = out.find((r) => rowLabel(r) === name);
    const rest = out.filter((r) => rowLabel(r) !== name);
    const at = rest.findIndex((r) => rowLabel(r) === anchor);
    if (!row || at < 0) continue;
    rest.splice(at + 1, 0, row);
    out = rest;
  }
  return out;
}

/**
 * **How many regional services one continent puts on the Continental card.**
 *
 * Six is the point where the row list stays a list: the card is a door into *where* titles
 * come from, and a continent that published every one of its services would bury its own
 * continent row under twenty brands.
 */
const CONTINENTAL_OTT_LIMIT = 12;

/**
 * **One service, one row.**
 *
 * Each Regional card is built from two reads of the same fact — every region's own services
 * (`regionalOtt`) and each continent's household names (`regionalOttByContinent`) — and the
 * same service is usually in both, so the card carried Hulu beside Hulu and TVING beside TVING.
 * The first row wins: a region's own listing keeps its place, and a continent's row stands only
 * where it is the card's only row for that service.
 */
const oneRowPerService = (rows) => {
  const seen = new Set();
  return rows.filter((row) => {
    // **The brand is the identity, not the number.** TMDB numbers a service per region, so
    // the same platform is two provider ids across two countries and the card carried it
    // twice — "Crunchyroll" beside "Crunchyroll". The name decides, and the id is only what
    // tells two same-named rows apart (`popKey` folds the punctuation away, so "Disney+" and
    // "Disney Plus" are the one brand).
    const key = popKey(row.name) || String(row.providerId ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * **Popular Regional OTT, continent by continent.**
 *
 * The Regional OTT card's own rows are the region in Settings — one country's services. This
 * is the same fact read wider, on the same card: for each continent the Continental card
 * publishes, the household names of **that continent's own countries**, in the order those
 * countries come in (`continentsWithContent`, the one list the card, the Country filter and
 * the search chips all read, so the three can never disagree).
 *
 * A service belongs to the **first continent it is verified in** — a pan-regional platform
 * listed for a country in two continents is one row, not two, and never a duplicate of the
 * row the Regional OTT card already carries ("Service · Continent" would have been the same
 * service twice under two names). The two worldwide Asian-catalogue services are left out
 * for the same reason: they are already on every region's Regional OTT card.
 */
function regionalOttByContinent(kind = "all") {
  const build = (type) => {
    const rows = [];
    // A service is published once, in the continent its first verified country sits in —
    // **by brand, not by id**: `Viki` and `Rakuten Viki` are two ids for one service, and
    // keying on the id alone published both (the duplicate pair the owner named).
    const used = new Set();
    const usedBrands = new Set();
    for (const [name, codes] of continentsWithContent()) {
      const seen = new Set();
      const seenBrands = new Set();
      let taken = 0;
      for (const code of codes) {
        if (taken >= CONTINENTAL_OTT_LIMIT) break;
        for (const svc of localServices(code, type)) {
          if (taken >= CONTINENTAL_OTT_LIMIT) break;
          // Crunchyroll and Viki are on every region's Regional OTT card already.
          if (WORLDWIDE.some((w) => w.id === svc.id)) continue;
          if (offTheShowsCard(type, svc.name)) continue;
          if (offTheDomesticCard(svc.name)) continue;
          if (!rowFillsAPage(svc.id, svc.region || code, type)) continue;
          const brand = popKey(brandOf(svc.name)) || String(svc.id);
          if (!isPopularRegional(svc.name) || seen.has(svc.id) || used.has(svc.id)) continue;
          if (seenBrands.has(brand) || usedBrands.has(brand)) continue;
          seen.add(svc.id);
          used.add(svc.id);
          seenBrands.add(brand);
          usedBrands.add(brand);
          // **`wider: true` is the row's passport past the region filter.** The live
          // catalog build replaces every `regional-ott` row with the *region's* own
          // services (see `withRegionalServices`); a continent row is not one of those and
          // is kept by its flag rather than being swept away with the static list.
          rows.push({
            name: kind === "top10" ? `${brandOf(svc.name)} | Top 10` : brandOf(svc.name),
            kind: "provider",
            providerId: svc.id,
            region: String(svc.region || code).toUpperCase(),
            wider: true,
            ...(kind === "top10" ? { take: TOP10 } : {}),
          });
          taken += 1;
        }
      }
    }
    return rows;
  };
  return { movie: build("movie"), show: build("tv") };
}

/** The country the collection set is built for unless Settings picks another. */
export const DEFAULT_COUNTRY = (process.env.AUTOCAT_REGION || "US").toUpperCase();

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
// `offcard` keeps a row **out of the card's own picture** without taking it out of the
// payload: `Watched` is a page of its own now (Settings → Content → Watched), and a row
// the card does not draw is exactly what that needs.
const watchlist = (name, state, offcard) => ({ name, kind: "watchlist", state, offcard: Boolean(offcard) });
// **The Updates card's two rows, and the only two rows in the app that a *service's* shelf decides
// rather than the world's calendar.** Half of TMDB is in the app and every month fifty titles leave
// it and fifty arrive, at random — the draw itself lives in `addon/index.mjs` (`shelfMonth`), the
// days are written down by `addon/lineup.mjs`, and neither row carries a TMDB window at any
// distance. See `addon/shelf.mjs` for the shelf and the owner's own words for it.
const arriving = (name, take) => ({ name, kind: "arriving", take });
const leaving = (name, take) => ({ name, kind: "leaving", take });

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
      const local = localFor(name, type).filter((svc) => isPopularRegional(svc.name));
      if (!local.length) continue;
      for (const svc of local) {
        // The same service can be listed for two countries (a pan-regional platform);
        // the region is part of the row's identity, so each one is its own row, and a
        // true duplicate of the same service *in the same region* is dropped.
        // **The region is an ISO code TMDB understands**, never the country's name —
        // `watch_region` takes the code, and a row carrying "JAPAN" would answer
        // nothing.
        const region = String(ROW_REGION[svc.name] || svc.region || code).toUpperCase();
        const key = `${svc.id}:${region}`;
        if (seen.has(key)) continue;
        seen.add(key);
        perCountry.push({ svc, code, region });
      }
    }
    // **One row per service name.** A pan-regional platform listed for several countries
    // used to be published once per country, each row wearing an ISO code (`Max · US`,
    // `Max · CA`) — the same service under several names, and the code was a piece of the
    // query leaking into the label. The first country a service is verified in is the
    // region its row is read in; the name is only the name.
    // **One row per brand**, not per spelling: the fold above is what makes `Viki` and
    // `Rakuten Viki` the same row (the owner's duplicate report).
    const byName = new Map();
    for (const row of perCountry) {
      const key = popKey(brandOf(row.svc.name)) || row.svc.id;
      if (!byName.has(key)) byName.set(key, row);
    }
    const rows = [...byName.values()]
      // **Not on the Shows card** — see `offTheShowsCard` — and **not a row that answers
      // nothing** — see `rowFillsAPage`.
      // **The row's own region, not the data's.** `region` here is the one the row is read in
      // (the first country it was verified in, or `ROW_REGION`'s override), which is what the
      // counts in `regional-counts.json` are keyed by.
      .filter(({ svc, region }) => !offTheShowsCard(type, svc.name) && !offTheDomesticCard(svc.name) && rowFillsAPage(svc.id, region, type))
      .map(({ svc, region }) => {
        const label = brandOf(svc.name);
        return kind === "top10"
          ? provider(`${label} | Top 10`, svc.id, region, TOP10)
          : provider(label, svc.id, region);
      });
    // The worldwide pair (Crunchyroll, Viki) belong to every region, so they are added
    // once at the end rather than once per country — and Crunchyroll is then put back
    // beside FOD, the row whose country it is read with (see `placeRowsAfter`).
    // **The worldwide pair is added once — unless the card already carries it.** Crunchyroll
    // and Viki belong to every region, so they were appended region-less; but TMDB also lists
    // Viki *in* several regions' data under its full name, and the card was publishing both
    // (`Viki` and `Rakuten Viki` — the duplicate pair the owner named). A brand the region pass
    // has already published is not published again, whatever spelling it arrives under.
    const publishedBrands = new Set(rows.map((r) => popKey(brandOf(r.name))));
    for (const svc of WORLDWIDE) {
      if (!rowFillsAPage(svc.id, null, type)) continue;
      const label = brandOf(svc.name);
      // The two worldwide services are both on the Specialist roster now (the owner's list has
      // Crunchyroll and Rakuten Viki in it), so they are not published here as well.
      if (offTheDomesticCard(label)) continue;
      if (publishedBrands.has(popKey(label))) continue;
      publishedBrands.add(popKey(label));
      rows.push(kind === "top10"
        ? provider(`${label} | Top 10`, svc.id, null, TOP10)
        : provider(label, svc.id, null));
    }
    return placeRowsAfter(rows);
  };
  return { movie: build("movie", "movie"), show: build("tv", "tv") };
}

/**
 * **Every row the two Regional cards would publish if nothing were culled.**
 *
 * This is the probe's roster (`scripts/probe-regional.mjs`), and it is deliberately blind to
 * the rules below it — the cull, the Shows-card list and the per-country caps. A roster that
 * followed the cull would lose a row's measurement the moment the row was culled, the next
 * build would find no measurement for it and publish it again, and the card would flip a row
 * in and out on every probe. The roster is the *union* of the two sources the cards draw from
 * (each country's own list, and the continents' wider read), one entry per service, carrying
 * the region that service's row is read in.
 */
export const regionalRoster = (media = "movie") => {
  const seen = new Set();
  const out = [];
  const push = (svc, code) => {
    if (seen.has(svc.id)) return;
    seen.add(svc.id);
    out.push({
      name: svc.name,
      id: svc.id,
      region: String(ROW_REGION[svc.name] || svc.region || code).toUpperCase(),
    });
  };
  // **`media`, the data's own list name** (`movie` | `tv`), because that is what
  // `localFor` reads — the same argument `regionalOtt`'s builder takes.
  for (const [name, code] of COUNTRIES) {
    if (!countryHasContent(name, media)) continue;
    for (const svc of localFor(name, media)) if (isPopularRegional(svc.name)) push(svc, code);
  }
  for (const [, codes] of continentsWithContent()) {
    for (const code of codes) {
      for (const svc of localServices(code, media)) if (isPopularRegional(svc.name)) push(svc, code);
    }
  }
  for (const svc of WORLDWIDE) push(svc, COUNT_FALLBACK_REGION);
  return out;
};

/**
 * **A row's label when TMDB's name is not the name the viewer knows.**
 *
 * `WeTV` is Tencent Video's own service: TMDB carries it under the international brand
 * and has no `Tencent Video` provider at all (its provider list for China is empty), so
 * the row says both names. The **id** is what the row is read with — never the label —
 * so a name is only ever a name.
 */
const ROW_LABEL = { WeTV: "WeTV (Tencent Video)" };

/**
 * **One brand, one row — however many spellings TMDB keeps.**
 *
 * The Regional card came back with a **duplicate pair** and the owner named it: `Viki` beside
 * `Rakuten Viki`, and `WeTV` beside `WeTV (Tencent Video)`. They are one service each, listed
 * under two names in two regions' data, and the existing dedupe could not see it because it
 * folds *punctuation*, not *words* — `popKey("Viki")` and `popKey("Rakuten Viki")` are
 * different keys. This map is the missing fold: the key is the folded name, the value is the
 * one label the row wears, and it is applied before the dedupe so the second spelling never
 * becomes a row.
 *
 * It only lists what the data actually repeats; a new pair belongs here the same way.
 */
const BRAND_FOLD = new Map([
  ["rakutenviki", "Rakuten Viki"],
  ["viki", "Rakuten Viki"],
  ["wetv", "WeTV (Tencent Video)"],
  ["wetvtencentvideo", "WeTV (Tencent Video)"],
  ["tencentvideo", "WeTV (Tencent Video)"],
  ["iqiyi", "iQIYI"],
]);

/** The row's own label: the folded brand name, or the name it came with. */
export const brandOf = (name) => BRAND_FOLD.get(popKey(name)) || ROW_LABEL[name] || name;

/**
 * **Where a row is read, when that is not where it was verified.**
 *
 * The region a regional row is asked for is the region it was verified in (`svc.region`),
 * which is the right answer until TMDB moves a service's catalogue. Two of them moved, and
 * the customer found both:
 *
 *   - **BritBox answers nothing in Britain.** Asked in GB (flatrate, 10+ votes) TMDB returns
 *     **0** films and **0** series for it — the row opened an empty page, which is the
 *     "BritBox catalog is empty" report. The same provider id answers **41 films and 321
 *     series** in the United States (41 / 314 in Canada), so the row is read there. Its
 *     *place* is untouched: the position comes from the data's own order — Britain's list,
 *     right after BBC iPlayer — and this map only decides the region the query carries.
 *   - **iQIYI's biggest catalogue is the United States'.** Verified in Morocco, where it
 *     answers 6 films and 34 series; the US answers 11 films and 56 series — more than Hong
 *     Kong's 7 / 36, and Thailand, Malaysia, Indonesia and the Philippines answer nothing at
 *     all. It is read in the US, and its row keeps Morocco's place on the card.
 *
 * A name in here is only ever a row whose *query* moves; the label, the position and the
 * provider id are the ones the data already had.
 */
const ROW_REGION = { BritBox: "US", iQIYI: "US" };

const TOP10 = 10;
// **"Soon" is a month, and it is the only window the Updates card has left.** The card used to be
// the two ends of a title's own stay — a title arrived on the day it was released and left a season
// later (`CATALOG_DAYS`, and 365 for a series), and both rows were read from that window. The
// owner's feature replaced the stay with a **shelf**: half of TMDB is in the app and each month
// fifty titles leave it and fifty arrive, drawn at random (`addon/shelf.mjs`), so the Leaving and
// Arriving rows carry *the service's* dates and not the world's — and the last thing that was left
// of the window, the `SOON_DAYS` constant the two rows used to read, is gone with it: "this month"
// is now `monthStart`/`monthEnd` in `addon/shelf.mjs`, one month for both rows, read on the shelf's
// own clock rather than as thirty days from today.
// **Fifty either way, and two months of it.** A turn is fifty titles — `SHELF_TURN` in
// `addon/shelf.mjs` is the same fifty — and a row is the *schedule*, so it holds this month's fifty
// and next month's (`SHELF_AHEAD` in `addon/index.mjs`; the owner's *"only 20 oct nahi, aage ka 1
// month yani october month then november month aise last tak"*). A hundred is that window, not a
// longer turn: the row reads October and then November, and the month after it is already drawn.
const UPDATES_TAKE = 100;
// **Discover Plus** publishes 25 titles per row rather than 10, so it is the one wide
// card that is worth scrolling. Its card key stays `discover-top-10` — that is the
// cover's filename (see the card's own entry for the name and its rows).
const TOP25 = 25;
const both = (list) => ({ movie: list, show: list.map((e) => ({ ...e })) });
/**
 * The Upcoming card's rows for one row type: the worldwide list first, then one per
 * country the Countries card publishes, each in arrival order.
 *
 * **It is the whole of the unreleased calendar, and the Updates card's Arriving row carries titles the
 * world has already released** — so the two cannot share a title, by construction rather than by a
 * boundary someone has to keep in step. A window of this card was given to that row for a round
 * (`after: SOON_DAYS`) while the row was a wave of *upcoming* titles, and the owner's answer was
 * *"its showing upcoming titles in arriving in card"*: the titles that have not landed are **this**
 * card's subject and nothing else's — the Arriving row's own days are the app's arrival days, which
 * are inside this month and have nothing to do with when the world released a title.
 *
 * **The near end is tomorrow, not today** (`after: 1`): a title whose day is today has arrived — it
 * is on the Updates card's Arriving row, and it is playable — so this card is strictly about days
 * that have not happened. Measured with the near end at today, thirteen titles were on both cards.
 *
 * The first row is what the card's own **spotlight** frame reads (see `startSpotlight`),
 * so it is the worldwide one — "what is next", not "what is next in Japan".
 */
const UPCOMING_ROWS = (type) => [
  curated("Upcoming", { sort_by: "date.asc", after: 1, future: 180 }),
  ...countriesFor(type).map(([name, code]) =>
    curated(`Upcoming in ${name}`, { with_origin_country: code, sort_by: "date.asc", after: 1, future: 120 })),
];
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
 * **The four Discover row lists, one per card and per media type.**
 *
 * The owner wrote these out by name, and they are not the same list for films and for shows: a
 * film can be a *Box Office Flop* and a show cannot, a show is a *Limited Series* or a
 * *Memorable Finale* and a film is not. The two cards used to publish five rows each, both out
 * of the same `both(...)` array, and three of the names below were never published at all.
 *
 * **Every row is a question, written as the query that answers it** (`curated`): a sort, the
 * vote floor that makes the sort mean something, and a window where "recent" or "turn of the
 * century" is the point. The floors were measured against TMDB before they were written down —
 * each of the 32 rows was asked with its own query and returns titles (the largest are in the
 * thousands, the keywords the smallest at 54 and 156), so no row on either card is an empty
 * shelf. Where a concept has a **keyword** TMDB actually applies (sequel, anthology, spin-off,
 * adaptation, festival, independent film) the row is that keyword plus a rating floor; where the
 * keyword is too sparse to fill a row (awards, ensemble casts, finales) the row is the shape of
 * title the name describes — the best reviewed of the widely seen — and says so.
 */
/**
 * **The Seasons card: the year's four seasons, in the order they come.**
 *
 * A show is not one date the way a film is — it is a first season, then a new one every year
 * or two — so "what is out" is not the question this card asks. It asks the question a season
 * name asks: *what started this summer?* Its four rows **are** the four seasons, in the order
 * the year runs them — Spring, Summer, Autumn, Winter — and each row is the window of dates
 * that season covers rather than a popularity guess, which is what makes the row and its name
 * the same thing.
 *
 * The months are the **meteorological** seasons (March–May, June–August, September–November,
 * December–February), which are the ones the words mean wherever the app is read: a calendar
 * season would make "Summer" three weeks of June. Winter is the one that crosses the year, so
 * its window runs from December of this cycle into February of the next.
 *
 * **Read from today every time the card is reopened**, so next March the card is that year's
 * four seasons without anything being edited, and the rows are named for the season alone —
 * *Summer* is summer, not summer of one year. **Both sides carry the five rows** — a film has no
 * season, so the card was shows-only for a round, until the owner asked for it on the film tab too
 * (*"movie tab me seasons card do aur contents bhi"*), and the row reads whichever date field the
 * media type has. None of them is capped, because a season is a window rather than a fixed list.
 */
// **Five, because the year has five here.** Spring, Summer, **Rainy** (the monsoon), Autumn and
// Winter — the owner's *"season me rainy aur fall bhi to aata hai"*, with Autumn in place of Fall
// (*"remove fall"*).
//
// **One month belongs to one season, and the five run in order.** The windows used to be three
// months each and they overlapped — Summer June–August, the rains July–September, Autumn
// August–October — so an August show was in **three rows at once**: measured on the screen,
// *Spider-Man: Brand New Day* opened both Summer and Rainy, and *Lanterns* sat in Summer, Rainy and
// Autumn. The owner's word on it is *"seasons me order t sahi karo"*, so the year is split into
// five consecutive runs, one season each: **Spring March–April, Summer May–June, Rainy (the
// monsoon) July–September, Autumn October–November, Winter December–February**. Spring is the
// row that opens the card and Winter the one that closes it, which is the order the year runs them.
// **And the card opens on Summer.** The owner's word: *"summer se na start hoga and jaise
// season hote hai"* — the rows are the seasons in the order they come, starting where the
// year's own cycle is read here: **Summer → Rainy → Autumn → Winter → Spring**, and then
// round again. Nothing else moves: one month belongs to one season, the five runs are
// consecutive and together they are the whole year (May–June, July–September, October–
// November, December–February, March–April).
const SEASONS = [
  { name: "Summer", first: 5, last: 6 },
  { name: "Rainy", first: 7, last: 9 },
  { name: "Autumn", first: 10, last: 11 },
  { name: "Winter", first: 12, last: 2 },
  { name: "Spring", first: 3, last: 4 },
];

/** `YYYY-MM-DD` for the first of a numbered month. */
const firstOfMonth = (year, month) => `${year}-${String(month).padStart(2, "0")}-01`;

/** The last day of a numbered month, read in UTC so no time zone can shift it a day. */
const lastOfMonth = (year, month) => {
  const last = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 0));
  const mm = String(last.getUTCMonth() + 1).padStart(2, "0");
  return `${last.getUTCFullYear()}-${mm}-${String(last.getUTCDate()).padStart(2, "0")}`;
};

const seasonsRows = () => {
  const year = new Date().getUTCFullYear();
  return SEASONS.map(({ name, first, last }) => {
    const endMonth = last;
    // `between` is the row's own shorthand for "first aired from this day to that day", on
    // whichever date field the media type uses (see `catalogSpecs`). **The name is the season
    // and nothing else** — a season is every year's, so "Summer 2026" dated a row that is
    // summer itself; the window is the year's reading of it, taken from today, and next year it
    // is next year's without anything being edited.
    // **Winter is the one that crosses the year**: it opens in December and closes in February, so
    // its window runs into the next one rather than looping back inside this one.
    const between = [
      firstOfMonth(year, first),
      lastOfMonth(endMonth < first ? year + 1 : year, endMonth),
    ];
    // Popularity is the order: what a season is worth watching is what people watched, and a
    // window that has not happened yet still fills (TMDB gives an unreleased title a
    // popularity of its own), so a row reads on both sides of today.
    return curated(name, { between, sort_by: "popularity.desc", "vote_count.gte": 0 });
  });
};

const discoverRows = () => ({
  // -- Discover, films: what a festival, a craft and a flop look like -----------------------
  movie: [
    curated("Festival Favorites", { with_keywords: "160213|250135", sort_by: "vote_average.desc", "vote_count.gte": 5 }),
    curated("Independent Standouts", { with_keywords: "281237", sort_by: "vote_average.desc", "vote_count.gte": 50 }),
    curated("Best Sequels", { with_keywords: "9663", sort_by: "vote_average.desc", "vote_count.gte": 100 }),
    curated("Genre Definers", { sort_by: "vote_count.desc", "vote_average.gte": 7.6, "vote_count.gte": 8000, before: 2001 }),
    curated("Technical Achievements", { sort_by: "vote_average.desc", "vote_average.gte": 8, "vote_count.gte": 2000, before: 2010 }),
    curated("Adaptation Standouts", { with_keywords: "818|9717|18712|286957", sort_by: "vote_average.desc", "vote_count.gte": 50 }),
    curated("Underrated Performances", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 300, "vote_count.lte": 1500 }),
    // The back of the money order: what cost the most and came back with the least.
    curated("Box Office Flops", { sort_by: "revenue.asc", "vote_count.gte": 500, "vote_average.gte": 5 }),
  ],
  // -- Discover, shows: the shapes a series has ---------------------------------------------
  show: [
    curated("Anthology Series", { with_keywords: "9706", sort_by: "vote_average.desc", "vote_count.gte": 20 }),
    curated("Genre Definers", { sort_by: "vote_count.desc", "vote_average.gte": 7.8, "vote_count.gte": 1500, before: 2011 }),
    curated("Character Arcs", { sort_by: "vote_average.desc", "vote_average.gte": 8, "vote_count.gte": 200 }),
    curated("Ensemble Casts", { sort_by: "vote_average.desc", "vote_average.gte": 7.8, "vote_count.gte": 500 }),
    curated("Memorable Finales", { sort_by: "vote_average.desc", "vote_average.gte": 8, "vote_count.gte": 300, before: 2015 }),
    curated("Spin-Offs", { with_keywords: "15285", sort_by: "vote_average.desc", "vote_count.gte": 20 }),
    curated("Industry Firsts", { sort_by: "vote_count.desc", "vote_average.gte": 8, "vote_count.gte": 300, before: 1991 }),
    curated("Record Breakers", { sort_by: "vote_count.desc", "vote_average.gte": 7.5, "vote_count.gte": 2000 }),
  ],
});

const discoverPlusRows = (take) => ({
  // -- Discover Plus, films: the canon, the money and the gems ------------------------------
  movie: [
    curated("Critically Acclaimed", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 2000 }, take),
    curated("Award Winners", { sort_by: "vote_average.desc", "vote_average.gte": 8, "vote_count.gte": 3000 }, take),
    curated("Staff Picks", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 200, within: 540 }, take),
    curated("Box Office Hits", { sort_by: "revenue.desc", "vote_count.gte": 1000, "vote_average.gte": 6.5 }, take),
    curated("Hidden Gems", { sort_by: "vote_average.desc", "vote_average.gte": 7, "vote_count.gte": 50, "vote_count.lte": 600 }, take),
    curated("Cult Classics", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 500, before: 2000 }, take),
    curated("All-Time Landmarks", { sort_by: "vote_count.desc", "vote_average.gte": 7.8, "vote_count.gte": 5000 }, take),
    // The money order again, this time asked of what has come out in the last three years.
    curated("Record Breakers", { sort_by: "revenue.desc", "vote_count.gte": 500, "vote_average.gte": 6, within: 1095 }, take),
  ],
  // -- Discover Plus, shows: the canon and the shapes only a series has ---------------------
  show: [
    curated("Critically Acclaimed", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 500 }, take),
    curated("Award Winners", { sort_by: "vote_average.desc", "vote_average.gte": 8.3, "vote_count.gte": 1000 }, take),
    curated("Staff Picks", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 100, within: 540 }, take),
    curated("Breakout Series", { sort_by: "popularity.desc", "vote_count.gte": 50, within: 500 }, take),
    // **A limited series is a shape, not a genre.** TMDB's own `with_type` says which kind of
    // show it is, and 2 is the miniseries — the row is that filter, best reviewed first.
    curated("Limited Series", { with_type: "2", sort_by: "vote_average.desc", "vote_count.gte": 50 }, take),
    curated("Hidden Gems", { sort_by: "vote_average.desc", "vote_average.gte": 7, "vote_count.gte": 50, "vote_count.lte": 300 }, take),
    curated("Cult Classics", { sort_by: "vote_average.desc", "vote_average.gte": 7.5, "vote_count.gte": 300, before: 2000 }, take),
    curated("All-Time Landmarks", { sort_by: "vote_count.desc", "vote_average.gte": 7.8, "vote_count.gte": 2000 }, take),
  ],
});


/**
 * **The Discover card's rows live in the Discover Plus card now.**
 *
 * The owner's note: *"discover card ki tags ko discover plus card me daal do, record breakers tag ke baad,
 * same order me jis order me discover card ke tags hain"* — the two cards are one idea split in two (the
 * canon, and the shapes of a series), and the wide card is where they belong together. So every row the
 * Discover card published is published **here**, **after the Record Breakers row**, in the Discover card's
 * own order; the Discover card publishes nothing of its own and is no longer drawn on Home.
 *
 * **Nothing is deleted.** The rows, their ids, their covers and their reads are all still here — only the
 * card that holds them changed, and every id keeps answering exactly as it did (`autocat-discover--…`).
 */
const discoverAllRows = (take) => {
  const plus = discoverPlusRows(take);
  const mine = discoverRows();
  const merge = (type) => {
    const list = [...plus[type]];
    const at = list.findIndex((row) => row && row.name === "Record Breakers");
    return at >= 0
      ? [...list.slice(0, at + 1), ...mine[type], ...list.slice(at + 1)]
      : [...list, ...mine[type]];
  };
  return { movie: merge("movie"), show: merge("show") };
};

/**
 * **The three period rows the Discover card opens on, at Top 10.**
 *
 * The Global and Regional Top 10 cards used to open straight onto one row per
 * service, which answered "what is on Netflix" before it answered "what is new
 * anywhere I can watch" — the question the card is named for. They open on the
 * same **Latest · Newest · Trending** set the Discover card carries, capped at
 * ten, and the service rows follow it.
 */
// **The period rows are off the Top 10 cards.** `Latest | Top 10`, `Newest | Top 10`
// and `Trending | Top 10` sat in front of every service row on the Global and Regional
// Top 10 cards, so "what is on Netflix" came after three rows that were not about
// Netflix. Both cards open on their own service rows.
const top10Periods = (_suffix = " | Top 10") => [];

/**
 * The order Home shows the cards in — explicit, and the single source of truth.
 *
 * The array below is grouped the way the cards were written (all the OTT cards
 * together, all the keyword cards together); this list is what you actually see.
 * The app never reorders or subsets the cards, so the order is the same on every
 * device, in both the Movies and the Shows row, and in AutoCAT itself.
 *
 * **The owner read the page top to bottom and said what it should be**: *"home card order should be
 * discover, genres, decades, continental & countries, seasons, runtime/episodes, based on the, moods &
 * vibes, themes & tags, then leave same gap here like gap between hero banner and card, then put
 * upcoming card but three card poster then right of it update card then under upcoming card watchlist
 * then library then leave a card gap then at last under update card, put recommendations"*.
 *
 * So the page reads in three parts, and this list is those three parts in that order:
 *   **the browsing cards** (what the catalogue is) — Discover first, then the shapes of a title: genre,
 *   decade, where it comes from, season, length, what it was made from, mood, theme;
 *   **the shelves of services** (where it plays) — the four OTT cards and the Specialist one, which the
 *   owner named neither way and keep the block they already had;
 *   **the foot** — Upcoming, Updates, Watchlist, Library, Recommendations, which is the one part of the
 *   order the app lays out itself (see `collectionGrid` in `desktop/ui/app.js`: a full-row gap opens it,
 *   Upcoming spans three of its neighbours, and one card's worth of nothing puts Recommendations under
 *   Updates).
 *
 * `based-on-the` sits directly after `runtimes`: the card order is the owner's
 * list, so "Based on the" belongs with the other shape-of-the-title cards (how
 * long it is, what it was made from) rather than down with the keyword cards.
 */
const CARD_ORDER = [
  // **Discover opens the page** — *"home card order should be discover, genres, decades, continental &
  // countries, seasons, runtime/episodes, based on the, moods & vibes, themes & tags"* — and the card
  // that opens it is the **wide one** (twenty-five a row), which holds both cards' rows since the merge
  // and wears the name *Discover* again. The plain `discover` entry below publishes nothing and is not
  // drawn; it stays listed so its key, cover and ids keep their place.
  "discover",
  // **The banner's own card.** It is not drawn on Home — its rows are the left half of the hero — and it
  // sits here so the two cards the app keeps for the banner read together at the top of the list.
  "on-the-board",
  "discover-top-10",
  // **Seasons sits with the browsing cards.** It is a date card like Discover — what is
  // arriving, what is back — so it follows the two that ask the same question about the whole
  // catalogue, and it is only drawn on the Shows tab (see the card's own note).
  "popular-by-genre",
  "top-rated-by-genre",
  // **Genres in or from decades sits in front of Genres.** The two are the same list
  // read two ways — every genre, and every genre since 1950 — so the narrower one
  // comes first and the plain list follows it, instead of being separated by the
  // decades cards.
  // **"Genre from ◆ Decades" is off Home**, as asked: the card and its rows stay defined under
  // `genre-from-decades`, and nothing draws it. Reading the same genre list two ways was the
  // argument for putting it in front of Genres — the owner's answer is that one of them is enough.
  "genres",
  "popular-by-decade",
  "top-rated-by-decade",
  "decades",
  // **Continental and Countries are one card.** They were the same list read twice -- a
  // continent is a wide country query -- and the owner asked for them to be a single card
  // without losing a row: every continent row and every country row is inside it (see the
  // card's own note). One key, so nothing points at a card that is gone.
  "continental",
  // **Seasons follows the countries.** It is the card of what is starting, back or finished,
  // so it comes straight after the card that says where.
  "seasons",
  "runtimes",
  "based-on-the",
  "moods-and-vibes",
  "themes-and-tags",
  // -- where it plays: the four OTT cards, then the Specialist shelf. -----------------------
  "global-ott-top-10",
  "global-ott",
  "regional-ott-top-10",
  "regional-ott",
  // **The Specialist card sits after the Domestic ones.** It is the same idea read one shelf
  // further in — the services a viewer picks *on purpose* rather than the ones their country
  // happens to lead with — so it follows the card it comes off.
  "specialist-top-10",
  "specialist",
  // -- **The foot of the page.** --------------------------------------------------------------
  // Five cards, in the owner's order: *"then put upcoming card ... then right of it update card then
  // under upcoming card watchlist then library ... then at last under update card, put recommendations"*.
  // None of them is drawn like the cards above: the foot is laid out by `collectionGrid` — a full-row gap
  // opens it, Upcoming is three cards long with Updates beside it, and one card's worth of nothing puts
  // Recommendations under Updates — so **this order is what places them on the screen**, and the only
  // thing that does.
  //
  // **Upcoming is the card of what is next**, three posters long, and it opens the foot; Updates — the
  // one card that turns over by itself every month — sits to its right, so the two "what is coming"
  // cards read across one line. Below them the two lists that are *yours*: the Watchlist, then the
  // Library. Then Recommendations, last, under Updates.
  "upcoming",
  "updates",
  "watchlist",
  "custom",
  "for-you",
  // **Off Home, and listed last so nothing has to move when it is switched back on.** The card and its
  // rows stay defined under `genre-from-decades` (see the note above them).
  "genre-from-decades",
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
      watchlist("Plan to Watch", "planned"),
      watchlist("Watched", "watched", true),
    ]),
  },
  {
    key: "for-you",
    // **The name is Recommendations, plural.** The owner asked for the label to say what the card is —
    // its rows are written from what you watch, and "For You" was the app's word for it, not his — and
    // then for the plural on it: *"put s in its label"*.
    lines: ["Recommendations"],
    scene: "watchlist",
    // **More like what you watch**: one row drawn from TMDB's own recommendations
    // for the titles in your Watchlist — watched first, then watching, then planned.
    catalogs: both([recommend("More Like What You Watch")]),
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
    // **Four cards long.** The card sat alone in the last row of Home at one card's width, which
    // read as a card that had been left over rather than as the foot of the page; the owner asked
    // for it "four card long", so it spans four of its neighbours and holds four poster cards —
    // the row of what is next, the same width as the four cards above it (`card-wide` in
    // `desktop/ui/style.css`, `iconBox` in `desktop/ui/app.js`).
    wide: true,
    // **A window on what is coming, not a shelf of four.** The app draws this card as a
    // **spotlight**: its frame holds **one** still, and that still changes every ten
    // seconds the way the hero banner's does — the next few things to arrive, shown one
    // at a time. A wall of posters said nothing a row does not say better; one picture at
    // a time reads as "this is what is next".
    //
    // **It is a card of four posters now, not one still.** The spotlight frame held a single
    // landscape picture that changed every ten seconds; it holds four poster cards now (`wide`
    // above), read from its own rows like every other card's wall. It stays out of the hero
    // rotation (`heroCandidates` names it): it is a glance at what is next, not a banner.
    // (`spotlight` was here; the card draws as the wide card of four posters now.)
    // **What is on its way, under your own list.** One row per row type: what is
    // coming to cinemas, and what airs next — sorted by the date it arrives, so the
    // nearest thing is the first thing, not the most popular thing.
    // **Every country that has something on the way, not just Hollywood.** The card used
    // to be TMDB's own US-centric list (one row for films, one for shows), so what was
    // out next in Tokyo, Seoul, Mumbai or Lagos was nowhere on it. Each row below is one
    // of the big film industries read in **release-date order from today forward**, which
    // is what "upcoming" means, so the nearest arrival is the first thing on it.
    // **Every country the Countries card publishes, in arrival order.** This was six
    // hand-written rows (Japan, Korea, India, France, Nigeria, China), so what was out
    // next in Seoul or Lagos was on the card and what was out next in Istanbul, Warsaw or
    // Manila was nowhere — the same "not just Hollywood" argument the Countries card is
    // built on, applied to what is coming rather than to what exists. The list is
    // `countriesFor`, the one function the Countries card, the search chips and the
    // continent rows all read, so the two cards can never disagree about which countries
    // there are. `date.asc` + `after` + `future` is the row's own shorthand: nearest arrival first,
    // from tomorrow to four months out, on the right date field for each row type — all of the
    // unreleased calendar, because it is this card's subject and no one else's.
    catalogs: {
      movie: UPCOMING_ROWS("movie"),
      show: UPCOMING_ROWS("show"),
    },
  },
  {
    key: "seasons",
    lines: ["Seasons"],
    scene: "seasons",
    // **A card on both sides.** Every row is a season of the year read through whichever date
    // field the media type has (`between` in `catalogs.mjs`) — a series' first airing then, a
    // film's release now — so the four rows are the same four and both tabs have them. It
    // published shows only for a round, on the reasoning that a film has no season; the owner's
    // ask was *"movie tab me seasons card do aur contents bhi"* — a card is worth having on the
    // tab that opens on it, and the rows behind it answer either way.
    catalogs: { movie: seasonsRows(), show: seasonsRows() },
  },
  {
    key: "discover",
    lines: ["Discover"],
    scene: "discover",
    // **Its rows are in the Discover Plus card now** — the owner's note, and `discoverAllRows` is where
    // they went, after that card's Record Breakers row and in this card's own order. The entry stays (its
    // cover, its key and its ids are all still this card's), it simply publishes nothing, so the grid does
    // not draw it. Nothing was deleted: the row reads are all in this file, exactly as they were.
    catalogs: both([]),
  },
  {
    // **The key stays `discover-top-10`** — it is the cover's filename, and the card it names is
    // the wide one (twenty-five titles a row). The **name is Discover**: it holds the Discover
    // card's own rows as well as its own (see `discoverAllRows`), so the two read as one card
    // again and it wears the one word for both — the owner's *"why discovery plus not renamed to
    // discover"*. The cover is generated from this line (`npm run generate`), so the artwork says
    // it too.
    key: "discover-top-10",
    lines: ["Discover"],
    scene: "spotlight-top-10",
    // **The six verdicts, at twenty-five a row.** The card is named for the questions only it
    // asks — what is acclaimed, what a pick is, what the gems are — so those are the rows it
    // holds; the plain **Discover** card beside it asks the seven orders.
    // **Its own rows, and the Discover card's after Record Breakers** (see `discoverAllRows`).
    catalogs: discoverAllRows(),
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
    hidden: true,
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

  // **International** — the period rows, then Top 10 for each platform.
  //
  // The card was called **Global**; the owner asked for **International** in the app's own
  // words (a worldwide row beside a country's own rows is *international* next to *domestic*).
  // The **key does not move**: it is the cover's filename and the catalog ids' prefix, so
  // renaming it would leave every published row behind.
  {
    key: "global-ott",
    lines: ["International"],
    scene: "global-ott",
    catalogs: both(globalOtt.all()),
  },

  // Regional OTT — **your region's** own services: Top 10, then the full list. The
  // rows are the regional OTT data itself, one per service, each scoped to the region
  // it was verified in, so a service verified for one market is still asked for that
  // market's titles. Covers stay title-only: drawing one service's name would be wrong
  // for a card that changes with the Region.
  // The card was called **Regional**; it is **Domestic** in the app's words now — what is on
  // *your* country's services, as against the International card's worldwide platforms. The
  // **key stays** `regional-ott*` for the same reason the International one's does: it names
  // the cover file and the catalog ids.
  {
    key: "regional-ott",
    lines: ["Domestic"],
    scene: "regional-ott",
    titleOnly: true,
    // **The region's services, and then the continents'.** The card is the one place the
    // regional services live, so the wider answer belongs here too: the household names of
    // each continent, named `Asia · TVING` (see `regionalOttByContinent`). It was briefly on
    // the Continental card, which is about *where titles come from* — the right card for
    // these rows is the one they are a regional OTT in.
    catalogs: (() => {
      const here = regionalOtt("all");
      const wider = regionalOttByContinent("all");
      return {
        movie: oneRowPerService([...here.movie, ...wider.movie]),
        show: oneRowPerService([...here.show, ...wider.show]),
      };
    })(),
  },

  // **Specialist | Top 10** — the art-house, documentary and niche catalogues.
  //
  // The card declares **no rows of its own**: `withSpecialistServices` publishes one
  // `<service> | Top 10` row for each service on the specialist list that TMDB actually
  // carries where you are (see the list in this file). Declaring ids here would mean baking
  // in a provider id per brand, and the region's own list is a better answer than any list
  // kept here: a service your country does not carry gets no row, and the id is TMDB's.
  //
  // `titleOnly` for the same reason the Domestic cards are: the card names one service per
  // row and the services differ by region, so a cover that drew one of them would be wrong
  // for the next reader. It reuses the Domestic Top 10's own scene rather than shipping with
  // no artwork at all.
  // **And the plain card the Top 10 one is the shelf of.** The two are one list read two
  // ways — the ten and the whole service — exactly as the Domestic and International cards
  // are built, and **this half was missing**: `withSpecialistServices` published a plain
  // `<service>` row for every specialist service beside the `<service> | Top 10` one, and
  // with no card carrying the `specialist` key those rows were published into nothing. The
  // owner asked for "the normal Specialist card" because the app showed only the Top 10s.
  {
    key: "specialist",
    lines: ["Specialist"],
    scene: "regional-ott",
    titleOnly: true,
    catalogs: both([]),
  },

  // **Updates** — what has just arrived, and what is on its way out: **the service's own shelf.**
  //
  // Both rows are the month's turn and nothing else. Half of TMDB is in the app
  // (`SHELF_SHARE` — a stable coin per title, `addon/shelf.mjs`), and once a month fifty titles
  // leave that half and fifty are drawn into it **at random**: no release window, no "newly
  // released", no trending list, no connection to the world's calendar in either row. The draw is a
  // function of the month's own name, so a month answers with the same fifty all month and the next
  // month answers with a different fifty (`shelfMonth` in `addon/index.mjs`); the days the turn gave
  // each title are written down by `addon/lineup.mjs`, and both are kept against the title and drawn
  // on its card (`New 3 Nov`, `Leaves 25 Oct`).
  {
    key: "updates",
    lines: ["Updates"],
    scene: "on-the-board",
    // **What is leaving leads, then what is arriving.** The card is read as a warning and a
    // promise, and the warning is the one with a deadline: a title on its way out is one you
    // have to watch *now*, so it is the first row on the card (the owner asked for it in that
    // order: "there should be first leaving soon then arriving soon").
    //
    // **A title named as leaving is out of the app from that moment** and does not come back — off
    // every card, out of the search and out of the filters (your own lists aside), which is the
    // owner's rule. **A title the turn brings in is in the app from its own day on**, for good: it
    // is a title the service carries now, which is what makes the two rows a turn rather than a
    // filter. Nothing here is drawn from the banner's rows, the on-the-board card or the Upcoming
    // card — the service's own two edges are the whole of it.
    catalogs: both([
      // **The month's fifty titles on their way out**, drawn from the half of TMDB the app carries,
      // each wearing the day it goes (`Leaves 25 Oct`) and out of the app from the moment this row
      // names it. It used to be a window — the last `SOON_DAYS` of a film's or a series' stay,
      // derived from its release day — and the window is what the shelf replaced: the owner's
      // feature is *"50 titles leave honge per month … randomly aur koi world upcoming ya newly
      // released se koi connection nahi"*.
      leaving("Leaving Soon", UPDATES_TAKE),
      // **The month's fifty titles the service is bringing in** — drawn at random from the half of
      // TMDB that is *not* in the app yet, each wearing the day it **joins** the app: today or a day
      // still to come this month (`Arrives 20 Oct`, `New 20 Oct` once that day has come), and never
      // the world's own release day. Every shape this row had before was a reading of the world's
      // calendar and showed
      // **unreleased** titles — the calendar's next month, a quarter of it in popularity order, a
      // Game-Pass-shaped wave of the next thirty days, the last month of releases — and the owner
      // said no to all of them the same way: *"the arriving soon in update card should not connected
      // to real world upcoming releases which is already in upcoming card"*, *"again you done same
      // world upcoming release shit in arriving row shit"*, *"its showing upcoming titles in
      // arriving in card"*. The shelf answers it for good, because the draw has no calendar in it at
      // all: a title arrives because the month picked it, which it can only be if the world has
      // already released it. Leave-it-empty and it is a real answer: a quiet month is a quiet row,
      // and the screen says nothing rather than apologising (`emptyRowText`).
      arriving("Arriving Soon", UPDATES_TAKE),
    ]),
  },

  {
    key: "continental",
    lines: ["Continental &", "Countries"],
    scene: "continental",
    // **Continental and Countries are one card, and no row was dropped for it.** The two cards
    // were one browse read twice -- six continent rows, then a row per country that holds its
    // own catalogue -- so the owner asked for them as one card rather than two halves of one
    // idea. Every continent row stays, every country row stays, and they keep the order the two
    // cards were in: the continents first (the wide query), then the countries. The entries are
    // the same (`continent`, `country`), so every link and every published id still resolves.
    catalogs: {
      movie: [
        ...continentsWithContent().map(([name, codes]) => continent(name, codes)),
        ...countriesFor("movie").map(([name, code]) => country(name, code)),
      ],
      show: [
        ...continentsWithContent().map(([name, codes]) => continent(name, codes)),
        ...countriesFor("show").map(([name, code]) => country(name, code)),
      ],
    },
  },
  // (Countries is not a card of its own any more: its rows are in the Continental card, which
  // is the two lists in one place.)
  {
    key: "runtimes",
    lines: ["Runtime"],
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
