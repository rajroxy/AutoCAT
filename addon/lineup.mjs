/**
 * **What has left the app, and what has not arrived in it yet.**
 *
 * The Updates card publishes two rows — **Leaving Soon** and **Arriving Soon** — and until now
 * they were only a pair of shelves: a title sat in the first while it happened to fall in the
 * row's date window and then fell out of it, and a title in the second was on its way in with
 * nothing saying when. The owner asked for the thing those two words actually promise, the way
 * a storefront does it: *"if leave then it disappears from the app"*, and *"arriving soon when
 * then that title appears in its specific card and catalogs"*, with **the date on the title's
 * own card**.
 *
 * So the two rows are not only read, they are **written down**, and the dates they imply become
 * real:
 *
 * - **Leaving Soon** is a window, not a list: `within: CATALOG_DAYS` days back, `olderThan:
 *   CATALOG_DAYS - SOON_DAYS` — the *last month* of a title's stay, so every title on the row
 *   really is out within the month. A title in it is out of the far edge of that window on
 *   `release + CATALOG_DAYS`, which is exactly the day the row stops answering with it — so that
 *   is its **leaving date**, and it is derived from the row's own definition rather than invented
 *   here. On that day the title is **gone from the app**: every card, every row and the search
 *   drop it (the one exception is your own lists — see `hideGone`).
 * - **Arriving Soon** looks `SOON_DAYS` days ahead, and each title in it carries its own
 *   release date, which is the day it lands. Until that day the title is **held off the shelves**
 *   — it is on the Updates card and the Upcoming card, both of which are *about* what is coming,
 *   and on no other row — and from that day on it is a title like any other, in whatever cards
 *   and catalogs it belongs to.
 *
 * **Why a file and not a calculation.** `release + 180` can be worked out for any title, but
 * "this one is leaving" cannot: the app's promise is about the titles its own Leaving Soon row
 * *named*, and re-deriving it later would either hide the whole back catalogue or nothing. The
 * store is that naming, kept: a small map of key → date, one file for the machine (what is
 * leaving the catalogue is not a fact about the person reading it).
 *
 * **It is a record, never the source.** Nothing here is read to *decide* what a row shows — TMDB
 * still answers every row, and the dates only sort, withhold and explain. A store that was lost
 * would leave the app exactly as it was before this file existed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "lineup.json");

/**
 * How long a title stays after it is out — **the far edge of the Leaving Soon row's window**
 * (`within: 180` in `scripts/collections.mjs`). Changing one without the other would put the
 * date on a card out of step with the row the title came off, so they are named here and the
 * row's own comment points back at this one.
 */
export const LEAVING_DAYS = 180;
/** How near "soon" is, at both ends of the window — the row's `future: SOON_DAYS` and the month
 *  of the staying window that Leaving Soon holds (`scripts/collections.mjs`). */
export const SOON_DAYS = 30;

/** The two rows that declare a date. The rest of the app only ever reads what they said. */
const LEAVING_ROW = "Leaving Soon";
const ARRIVING_ROW = "Arriving Soon";

/** The rows of the two cards that are *about* what is coming — the ones nothing is held off. */
const COMING_CARDS = new Set(["updates", "upcoming"]);

const day = (d) => `${d.toISOString().slice(0, 10)}`;
const today = () => day(new Date());
/** `iso` is a `YYYY-MM-DD`; the arithmetic is done on the day itself, in UTC. */
const plusDays = (iso, n) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5));
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

const keyOf = (m) => `${m?.type === "series" ? "series" : "movie"}:${String(m?.id || "")}`;
/** The day a title lands: a film's release, a series' first airing. */
const releaseOf = (m) => (isDay(m?.releaseDate) ? m.releaseDate : "");

let cache = null;

function load() {
  if (cache) return cache;
  cache = { leaving: {}, arriving: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const bag of ["leaving", "arriving"]) {
      for (const [k, v] of Object.entries(raw?.[bag] || {})) if (isDay(v)) cache[bag][k] = v;
    }
  } catch {
    /* no file yet — nothing has been declared, which is the state before the first read */
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(load(), null, 2) + "\n");
  } catch {
    /* a read-only fs: the map still holds for this run */
  }
}

/**
 * **Write down what a row just said.**
 *
 * Called with the row's own name and the titles it answered with, on every read of the Updates
 * card. A title already recorded keeps the date it was first given: the leaving date is the same
 * for the same title on every read (it comes off its release date), and a title that came in on
 * the Arriving row must not have its arrival pushed out by a later read of a wider window.
 */
export function note(rowName, metas) {
  const list = Array.isArray(metas) ? metas : [];
  if (!list.length) return;
  if (rowName !== LEAVING_ROW && rowName !== ARRIVING_ROW) return;
  const arriving = rowName === ARRIVING_ROW;
  const bag = load()[arriving ? "arriving" : "leaving"];
  const now = today();
  let wrote = false;
  // **An arrival that has been and gone is not a date any more.** The row reads thirty days
  // ahead, so tomorrow it answers with the same titles again — and a title that landed last week
  // would keep "Arrives 8 Oct" on its card for good if the entry were kept. The day it lands it
  // is recorded (so the card can say so), and the next read drops it: from then on it is a title
  // like any other, which is the whole point of the arrival.
  if (arriving) {
    for (const [k, on] of Object.entries(bag)) {
      if (on < now) {
        delete bag[k];
        wrote = true;
      }
    }
  }
  for (const m of list) {
    const key = keyOf(m);
    if (!key.endsWith(":") && bag[key]) continue;
    const landed = releaseOf(m);
    if (!landed) continue;
    // A **leaving** date that is already behind us is not a warning, it is a tombstone — the
    // title is recorded so it can stay gone, and it is filtered out of the row it was read on.
    const date = arriving ? landed : plusDays(landed, LEAVING_DAYS);
    if (arriving && date < now) continue;
    bag[key] = date;
    wrote = true;
  }
  if (wrote) save();
}

/** The day this title leaves, or "" — the app's own recorded promise, not a guess. */
export const leavingOn = (m) => load().leaving[keyOf(m)] || "";

/** The day this title lands, or "". */
export const arrivingOn = (m) => load().arriving[keyOf(m)] || "";

/** Has it left? (Its leaving date is today or behind it.) */
export const hasLeft = (m) => {
  const at = leavingOn(m);
  return Boolean(at) && at <= today();
};

/** Has it landed yet? (Only titles with a recorded arrival are ever held back.) */
export const isComing = (m) => {
  const at = arrivingOn(m);
  return Boolean(at) && at > today();
};

/**
 * **Drop what has left — everywhere but your own lists.**
 *
 * The promise is that a title which left the catalogue is gone from the app, and that is what
 * this does to every card, every row and the search. **Your own lists are the exception**: a pin
 * and a Library row are things *you* wrote, and rewriting them behind your back would be the app
 * losing your list rather than the catalogue losing a title. There it stays, wearing the date it
 * left (`Leaves 3 Nov` — see `lineupTag` in the app), so the one place it is still on screen
 * says why.
 */
export function hideGone(metas, keep = false) {
  const list = Array.isArray(metas) ? metas : [];
  if (keep || !list.length) return list;
  const gone = list.filter((m) => hasLeft(m));
  return gone.length ? list.filter((m) => !hasLeft(m)) : list;
}

/**
 * **Hold back what has not arrived.**
 *
 * A title with an arrival date in front of it belongs on the two cards that are about what is
 * coming, and nowhere else yet: it must not turn up in a country row, a genre row or a decade
 * ladder while it is still only announced. `cardKey` is the card the row belongs to, so the
 * Updates and Upcoming rows are let through — they are the two whose whole point is the date.
 */
export function hideComing(metas, cardKey = "") {
  const list = Array.isArray(metas) ? metas : [];
  if (!list.length || COMING_CARDS.has(String(cardKey || ""))) return list;
  const held = list.filter((m) => isComing(m));
  return held.length ? list.filter((m) => !isComing(m)) : list;
}

/** Put the two dates on the metas themselves, so the card can carry them (see `lineupTag`). */
export function withDates(metas) {
  for (const m of Array.isArray(metas) ? metas : []) {
    const leaving = leavingOn(m);
    const arriving = arrivingOn(m);
    if (leaving) m.leavingOn = leaving;
    if (arriving) m.arrivingOn = arriving;
  }
  return metas;
}

/**
 * The card key inside a catalog id: `autocat-upcoming--upcoming-in-japan` is a row of the
 * **upcoming** card. The id is the one thing every row carries on its own (`parsed.def.id`), so
 * the two "what is coming" cards are recognised by it rather than by a list of row names.
 */
export const cardKeyOfRow = (id) => String(id || "").replace(/^autocat-/, "").split("--")[0] || "";

/** What the store holds — for the screen that shows it, and for the checks. */
export function payload() {
  const all = load();
  const now = today();
  const rows = (bag) => Object.entries(bag).map(([key, on]) => ({ key, on, type: key.split(":")[0] }));
  return {
    leaving: rows(all.leaving).sort((a, b) => a.on.localeCompare(b.on)),
    arriving: rows(all.arriving).filter((r) => r.on > now).sort((a, b) => a.on.localeCompare(b.on)),
    today: now,
    leavingDays: LEAVING_DAYS,
  };
}
