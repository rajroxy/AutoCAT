/**
 * **The shelf — half of the catalogue, and fifty titles either way every month, drawn at random.**
 *
 * Up to now the app carried *all* of TMDB and the Updates card was the two ends of a title's own
 * stay: it arrived on the day it was released and left a season later, and **Leaving Soon** and
 * **Arriving Soon** were therefore a reading of the world's calendar. The owner's word for what
 * this feature is instead:
 *
 *   *"pehle to app me se tmdb ka half titles hatana hoga … then unn half me 50 titles leave honge
 *   per month and 50 titles aayenge per month randomly aur koi world upcoming ya newly released se
 *   koi connection nahi sab random hoga"*
 *
 * So the app is a **service with a shelf**, not a mirror of a catalogue:
 *
 * - **Half of TMDB is on it.** A title is in the app when a stable coin on its own key says so
 *   (`onShelfCoin`) — `SHELF_SHARE` of the catalogue, the same half on every row, in search, in
 *   the filters, on every machine and in every run, because it is a hash of the title and not a
 *   decision taken at run time. The other half is not in the app at all; it is the **pond the
 *   arrivals are fished out of**.
 * - **Fifty leave and fifty arrive every month**, and the draw is random: a `mulberry32` seeded
 *   from the month's own name (`2026-10`), over a pool of TMDB pages that are the same pages all
 *   month and different ones next month. Nothing in the draw looks at a release day, a trailer, a
 *   "trending" list or the world's news — an arrival is a title the service has decided to carry,
 *   and the day it arrives in the app is a day the draw gives it.
 * - **The month is the unit.** The draw is a function of the month key alone, so every read inside
 *   one month answers with the same fifty titles, a restart or a second machine answers with the
 *   same fifty, and the first day of the next month is a different fifty. That is what makes the
 *   feature *tellable* rather than a slot machine.
 *
 * **The two rows are the only things that ever name a title.** `addon/lineup.mjs` writes the day
 * the draw gave each one down (the store), and every other row, the search and the filters read
 * that record: a title named as leaving is out of the app from the moment it is named, and a title
 * the draw brought in is in it from its own day on. Nothing here decides what a row shows on its
 * own — the rows read TMDB as they always did and this module only says which half is the app's
 * and which fifty this month's turn is.
 */

/**
 * **How much of the catalogue the service carries: half of it.** The owner's number, and the one
 * knob for it — `0.5` is "half of TMDB is out", `1` is the app as it was before the shelf (no
 * title is ever off it), `0.25` is a quarter. It is a share of the *catalogue*, not of a card: a
 * title is on the shelf or it is not, and that is true of every row at once.
 */
export const SHELF_SHARE = 0.5;

/** **Fifty either way, per month.** `50` leave and `50` arrive, which is what the owner asked for. */
export const SHELF_TURN = 50;

/**
 * How many pages of TMDB one month's draw reads, and how far down the popularity order they may
 * come from.
 *
 * The pool is not the *order* — the draw shuffles it — but a page of TMDB's popularity order is
 * where titles a person recognizes live, and a page pulled from anywhere in the first sixty is
 * where the variety comes from. Two of the pages are always the first two (so a month always has
 * some names on it) and the rest are seeded-random, which is what makes October's fifty read like
 * nothing in particular rather than like November's.
 */
export const SHELF_PAGES = 10;
export const SHELF_PAGE_SPREAD = 60;

/** The 32-bit span every hash and every roll below is a fraction of. */
const SPAN = 4294967296;

/**
 * FNV-1a, 32 bits — **a coin per string, and the same coin every time.**
 *
 * Two runs, two machines and two languages must agree on which half of TMDB is in the app, so the
 * membership is a hash of the title's own key and never a random number drawn at run time. (A
 * random draw would make the app's whole catalogue change on every restart.)
 */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** **Is this title one the service carries?** — the coin itself: half of the catalogue, by hash. */
export const onShelfCoin = (key) => hash32(`shelf:${key}`) < SHELF_SHARE * SPAN;

/**
 * mulberry32, seeded from a string — **the month's own dice**.
 *
 * Every random decision in this feature is a roll of *these* dice and not of `Math.random`: the
 * seed is the month, so the same month rolls the same numbers on every read, in every process and
 * on every machine, and the next month rolls different ones. `Math.random` would redraw the fifty
 * on every request and the Updates card would flicker.
 */
export function seededRandom(seed) {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / SPAN;
  };
}

/** The month a day belongs to, `2026-10` — the key the whole draw hangs off. */
export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
/** The first day of a month key. */
export const monthStart = (month) => `${month}-01`;

/**
 * **The last day of a month key** — the far end of the window a leaving day is drawn from.
 *
 * The leaving day is kept inside the month the row belongs to, and it is not a cosmetic choice: a
 * title named in October can then never carry a November day, so *"named before this month"* is a
 * question the store can answer from the day alone (`leftBefore` in `addon/index.mjs`), and the
 * month's turn cannot name a title an earlier month already took out.
 */
export const monthEnd = (month) => {
  const [year, mon] = String(month).split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
};

/**
 * **The month after a month key**, `2026-10` → `2026-11`.
 *
 * The two dated rows are a *schedule*, and a schedule that stopped at the end of the calendar month
 * would run out in the middle of it: on the 20th there are eleven days left to spread fifty arrivals
 * over, and on the 31st there is nothing. The owner's word for the window is *"only 20 oct nahi,
 * aage ka 1 month yani october month then november month aise last tak"* — so a row shows **this
 * month and the one after it**, and the day after this month ends the schedule already holds the
 * month beyond that.
 */
export const monthNext = (month) => {
  const [year, mon] = String(month).split("-").map(Number);
  return mon >= 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
};

/** A day, `n` days away from another. (One place for the arithmetic, all of it in UTC.) */
export const shiftDay = (iso, n) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** How many days lie between two days, `to` minus `from`. */
export const daySpan = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 864e5);

/** The later of two days (both `YYYY-MM-DD`, so the string order is the calendar order). */
export const laterDay = (a, b) => (String(a) >= String(b) ? a : b);

/**
 * **The draw: `n` titles out of `list`, in an order nobody can predict from the list.**
 *
 * A Fisher–Yates shuffle of a copy with the month's dice, then the first `n`. The copy matters: the
 * pool is a cache that the next read — and the next row — also draws from.
 */
export function draw(list, n, seed) {
  const a = [...list];
  const rand = seededRandom(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

/**
 * **The turn: the `n` titles whose own coin comes out best for that month.**
 *
 * The same idea as `onShelfCoin` — a hash of the title's own key — with the month, the row and the
 * media type mixed in, so the fifty are as unpredictable as a shuffled draw and **do not depend on
 * the order the pool happened to be written in, or on how many other titles are in it**.
 *
 * That is the difference that matters. A Fisher–Yates shuffle (`draw` above) is order-sensitive: the
 * pool is filled from ten HTTP answers and from a store that grows as rows are read, so a title
 * arriving at the front of the pool reshuffled everything behind it. Measured on a real restart:
 * **43 of a row's 100 titles changed** between two processes reading the same pages, and a server a
 * month ahead shared only 33 of the 52 titles the two schedules had in common. With a per-title
 * coin, a pool that gains or loses a title moves **that title's** place and no one else's.
 *
 * Ties are broken by the key, so the answer is a function of the pool *set* alone — every process, on
 * every machine, inside one month, answers the same fifty.
 */
export function pick(list, n, seed, key = (m) => `${m?.type || ""}:${m?.id || ""}`) {
  return [...(Array.isArray(list) ? list : [])]
    .map((item) => ({ item, rank: hash32(`${seed}:${key(item)}`) }))
    .sort((a, b) => a.rank - b.rank || String(key(a.item)).localeCompare(String(key(b.item))))
    .slice(0, Math.max(0, n))
    .map((x) => x.item);
}

/**
 * **The pages one month's draw reads** — the first two, then seeded-random ones inside
 * `SHELF_PAGE_SPREAD`, and never the same page twice inside one draw.
 */
export function pagesFor(month, salt, count = SHELF_PAGES, spread = SHELF_PAGE_SPREAD) {
  const rand = seededRandom(`${month}:${salt}:pages`);
  const pages = [1, 2];
  while (pages.length < count) {
    const page = 1 + Math.floor(rand() * spread);
    if (!pages.includes(page)) pages.push(page);
  }
  return pages.slice(0, count);
}

/** **The day this month's turn gives a title**, anywhere in `from … to` inclusive. */
export function dayFor(seed, fromIso, toIso) {
  const span = Math.max(0, daySpan(fromIso, toIso));
  return shiftDay(fromIso, Math.floor(seededRandom(seed)() * (span + 1)));
}
