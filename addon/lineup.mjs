/**
 * **What has left the service, and what the month has brought in.**
 *
 * The Updates card publishes two rows — **Leaving Soon** and **Arriving Soon** — and they are the
 * app's two ends: what is going out of it, and what it is bringing in. Each is a *schedule* for the
 * month, so both read forward from today — a title named as leaving goes on or after today, and one
 * named as arriving **joins on or after today** (`Arrives 20 Oct`, `New 20 Oct` once that day has
 * come), which is what a service's own "coming soon" list does. Until now both ends were a
 * *reading of the world's calendar*: `Leaving Soon` was the last month of a title's stay, derived
 * from its release day, and `Arriving Soon` was the last month of TMDB's releases. The owner's
 * feature replaces that with a **service's own shelf** (see `addon/shelf.mjs`):
 *
 *   *"pehle to app me se tmdb ka half titles hatana hoga … then unn half me 50 titles leave honge
 *   per month and 50 titles aayenge per month randomly aur koi world upcoming ya newly released se
 *   koi connection nahi sab random hoga"*
 *
 * - **Half of TMDB is in the app, and the other half is not** (`onShelf`): a stable coin on the
 *   title's own key, plus every title the shelf has brought in **whose day has come**. Every row,
 *   the search and the filters read that one answer, so the app is one library rather than a filter
 *   on some rows — and a title the month has announced but not reached is in none of them, only on
 *   the Updates card that announced it.
 * - **Fifty leave and fifty arrive every month, at random.** The draw itself lives in
 *   `addon/index.mjs` (it is the two rows), and this file is what *remembers* it: the day the draw
 *   gave a title is written down here, and from then on it is a fact about the title.
 *
 * **Why a file and not a calculation.** "This one is leaving" has to survive the month it was said
 * in — a title named as leaving is out of the app from that moment and does not come back — and
 * "this one arrived in the app today" is the day the service said so, which is no title's release
 * day. Neither can be re-derived later, so the store is that naming, kept: two maps of key → day,
 * one file for the machine (what a service carries is not a fact about the person reading it).
 *
 * **It is a record, never the source.** Nothing here decides which titles a row shows — the rows
 * read TMDB and draw the month themselves — and the record only carries the dates the two rows
 * name, drops what has gone, and keeps off the shelves what was never on them. A store that was
 * lost would leave the app with the same monthly draw and fresh dates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// **One source of truth for the window.** Both rows are the month's own turn (fifty in, fifty out),
// and a row holds this month's and the next month's (`SHELF_AHEAD` in `addon/index.mjs`), so a day on
// a schedule is inside its own month and on or after today — which is what makes the store's own day
// enough to tell "named before this month" from "named in it".
import { SHELF_SHARE, SHELF_TURN, monthEnd, monthNext, monthOf, monthStart, onShelfCoin } from "./shelf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "lineup.json");

/** The two rows that declare a date. The rest of the app only ever reads what they said. */
const LEAVING_ROW = "Leaving Soon";
const ARRIVING_ROW = "Arriving Soon";

/**
 * **The one card whose rows are about *now*.** Now Playing, Airing Today and On the Air are not
 * shelves of titles, they are statements about the calendar: something that lands tomorrow is not
 * playing today. This is the only place a title that has not landed is still held back — everywhere
 * else (search, the filters, every genre, country and decade row) an unreleased title is in the app
 * like any other, which is what the owner asked for.
 *
 * It exists because TMDB's own now-playing list carries a day or two of pre-releases: a film
 * releasing tomorrow is in both `now_playing` and the upcoming window, so without this the same
 * poster would sit on two rows at once.
 */
const NOW_CARDS = new Set(["on-the-board"]);

const day = (d) => d.toISOString().slice(0, 10);
const today = () => day(new Date());
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

/**
 * **A title's key**: its kind and its own id. The same string the shelf's coin is taken on and the
 * same one the store is written against, so `movie:tmdb:1339274` means one title everywhere.
 */
export const keyOf = (m) => `${m?.type === "series" ? "series" : "movie"}:${String(m?.id || "")}`;

let cache = null;

function load() {
  if (cache) return cache;
  cache = { leaving: {}, arrived: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const bag of ["leaving", "arrived"]) {
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
 * card. The day comes off the meta (`shelfOn`), which is the day the month's draw gave that title —
 * a row never invents a date, so the store and the row can never disagree about one.
 *
 * **The first word is the one that counts.** A title the store has already dated keeps it: the
 * month's draw is the same all month, and if a title is ever re-drawn (a store that was lost, a
 * pool that shifted under it) the day it first arrived is the day it arrived.
 */
export function note(rowName, metas) {
  const list = Array.isArray(metas) ? metas : [];
  if (!list.length) return;
  if (rowName !== LEAVING_ROW && rowName !== ARRIVING_ROW) return;
  const bag = load()[rowName === ARRIVING_ROW ? "arrived" : "leaving"];
  let wrote = false;
  for (const m of list) {
    const key = keyOf(m);
    const on = isDay(m?.shelfOn) ? m.shelfOn : "";
    if (!key || !on || bag[key]) continue;
    bag[key] = on;
    wrote = true;
  }
  if (wrote) save();
}

/**
 * **Is this title one the service carries?**
 *
 * The whole of the app's library in one function: **the coin** (half of TMDB — `onShelfCoin`), or a
 * title the shelf has brought in — **on its own day and not before it**. An arrival is announced
 * ahead of time, the way a service announces what is joining it this month (`Arrives 20 Oct` on the
 * poster), and the announcement is not the title: until that day the app does not carry it at all, so
 * it is on the Updates card — the card that *is* the announcement — and off every row, out of the
 * search and out of the filters. On the day itself it is a title of the app like any other, and it
 * stays one (`New 20 Oct` on the poster for the rest of the month).
 *
 * A title that has *left* is not on it either — that is `isLeaving`, asked separately, because leaving
 * is a word about a title the app used to carry and this one is about what it carries at all. **It
 * is a question about the day, not about the naming**: the Leaving row announces ahead (it is a
 * schedule, `Arrives`' mirror image — `Leaves 20 Nov` reads for weeks), and the title goes from the
 * app on its own day, which is what "those who leaved should hide from whole app" means.
 */
export const onShelf = (key) => {
  if (!key) return false;
  if (onShelfCoin(key)) return true;
  const day = load().arrived[key] || "";
  return isDay(day) && day <= today();
};

/** `onShelf`, asked of a meta rather than of a key. */
export const inService = (m) => onShelf(keyOf(m));

/**
 * **The day this title leaves, exactly as the store has it** — "" for a title the row never named.
 *
 * The raw record, windowed or not. `leavingOn` below is the same day *as a tag* (it blanks a day that
 * belongs to a month the app is no longer scheduling), and this is what the row's own arithmetic and
 * the store's report ask — the same split as `joinedOn`/`arrivingOn` for the other end.
 */
export const leavingDay = (m) => load().leaving[keyOf(m)] || "";

/** Has it left? (Its leaving day is today or behind it.) */
export const hasLeft = (m) => {
  const at = leavingDay(m);
  return Boolean(at) && at <= today();
};

/**
 * **Is it leaving? (Has its day come?)**
 *
 * The row announces ahead — `Leaves 20 Nov` on a poster is the warning a service prints weeks before
 * it happens — and the title is still a title of the app until the day itself, when it goes from the
 * cards, the search and the filters (`hideGone`). The owner's word for it is the plain one: *"those
 * who leaved should hide from whole app"* — the hiding follows the leaving, not the naming. A title
 * named for a day still to come is on the Leaving row with its date, and everywhere else as usual.
 */
export const isLeaving = (m) => hasLeft(m);

/**
 * **The day a title joined the shelf, exactly as the store has it** — "" for a title the shelf has
 * never brought in.
 *
 * This is the raw record, and the difference from `arrivingOn` below is the difference between a
 * fact and a tag: `arrivingOn` answers *is this still news* (it blanks a title that came in longer
 * ago than a month), while this answers *when did it come in*, which is what the month's own turn
 * asks — a title an **earlier** month brought in is a title the app carried when this month began.
 * See `shelfMonth` in `addon/index.mjs` for why that distinction decides which fifty arrive.
 */
export const joinedOn = (m) => load().arrived[keyOf(m)] || "";

/**
 * **The last day the app is scheduling** — the end of the month after this one.
 *
 * The two dated rows are a schedule two months long (`SHELF_AHEAD` in `addon/index.mjs`): this month's
 * fifty and next month's. A tag is read inside that window and nowhere else — a title that arrived in
 * March is a title like any other by April, and one that left in March is simply gone.
 */
export const scheduleEnd = () => monthEnd(monthNext(monthOf()));

/** Is this day inside the window the app is scheduling? (A day still to come, or one just gone.) */
const scheduled = (at) => isDay(at) && at >= monthStart(monthOf()) && at <= scheduleEnd();

/**
 * **The day a title joins the service — the month's own, and it may be ahead of today.**
 *
 * The store keeps the day for good (it is what makes a title the shelf brought in a title the app
 * carries), and the *tag* is the schedule's: `New 3 Nov` for a day that has happened, `Arrives 20 Oct`
 * for the one the shelf has announced and not reached yet — the same two words the app has always
 * used for the two sides of today, now on the app's own arrival days rather than the world's release
 * days. A title that joined before the window opened wears nothing: by this month it is a title like
 * any other.
 */
export const arrivingOn = (m) => {
  const at = load().arrived[keyOf(m)] || "";
  return scheduled(at) ? at : "";
};

/**
 * **The day a title leaves the service, as a tag** — the same window as `arrivingOn`, and the mirror
 * image of it: `Leaves 20 Nov` while the day is ahead, and nothing at all once the window has moved
 * past it (by then the title is not in the app and has nothing to say).
 */
export const leavingOn = (m) => {
  const at = leavingDay(m);
  return scheduled(at) ? at : "";
};

/**
 * **Has it landed yet? — the title's own release day, not a note about it.**
 *
 * The one fact that says a title is still to come is its own day, which every meta already carries:
 * a stronger answer than a store's, because it holds for a title whose row was never read at all.
 * It is what `hideNotYet` uses to keep a pre-release off a row that claims the title is on *now*.
 */
export const isComing = (m) => {
  const at = isDay(m?.releaseDate) ? m.releaseDate : "";
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
export function hideGone(metas, keep = false, cardKey = "") {
  const list = Array.isArray(metas) ? metas : [];
  void keep; // **the slot stays, the escape does not** — see the note below
  // **The Updates card is where the leaving is announced, so its own rows are let through.**
  // Everything else drops a title once its day has come, which is the owner's rule: it is off the
  // shelves, out of search, out of the filters — and, restated, **out of your own lists too**:
  // *"those who leaved and didnt arrived yet remove them from app, make that app do these things
  // automatically"*. The `keep` escape that used to hold a pin on a card the app no longer
  // carries is gone with it: a title that has left the catalogue is not a title of the app, on
  // any row, in anyone's list.
  if (!list.length || String(cardKey || "") === "updates") return list;
  const gone = list.filter((m) => isLeaving(m));
  return gone.length ? list.filter((m) => !isLeaving(m)) : list;
}

/**
 * **Drop what was never on the shelf — everywhere but your own lists, and but the Updates card.**
 *
 * The other half of the library rule, and the same shape as `hideGone`: **half of TMDB is not in
 * the app at all** (`onShelf`), so a title outside that half is not on a row, not in the search and
 * not in the filters — it is the pond the monthly arrivals are drawn from. Your own lists are the
 * exception for the same reason as above (a pin is something you wrote), and so is the Updates card:
 * its Arriving row is *made* of titles the service is bringing in, and that row has to be readable
 * even in the moment before its own read has been written down.
 */
export function hideOffShelf(metas, keep = false, cardKey = "") {
  const list = Array.isArray(metas) ? metas : [];
  void keep; // **the slot stays, the escape does not** — see the note below
  // **And the same for a title the app does not carry yet.** An announced arrival belongs to the
  // card that announced it and to nothing else — not to a pin, not to a Library row. (The Updates
  // card is the announcement, so its own rows are let through; every other row, including your
  // own, reads the same answer.)
  if (!list.length || String(cardKey || "") === "updates") return list;
  const off = list.filter((m) => !onShelf(keyOf(m)));
  return off.length ? list.filter((m) => onShelf(keyOf(m))) : list;
}

/**
 * **Hold back what has not landed — on the rows that are about now, and only those.**
 *
 * An arriving title is *in* the app — searchable, filterable, sitting in whatever genre, country or
 * decade row it belongs to — and the only thing it lacks is something to play. The single exception
 * is a row that claims the title is on **now** (`NOW_CARDS`), where a film that lands tomorrow would
 * be a plain lie; it joins those rows on the day it lands.
 */
export function hideNotYet(metas, cardKey = "") {
  const list = Array.isArray(metas) ? metas : [];
  if (!list.length || !NOW_CARDS.has(String(cardKey || ""))) return list;
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
 * the two \"what is coming\" cards are recognised by it rather than by a list of row names.
 */
export const cardKeyOfRow = (id) => String(id || "").replace(/^autocat-/, "").split("--")[0] || "";

/** What the store holds — for the screen that shows it, and for the checks. */
export function payload() {
  const all = load();
  const now = today();
  const rows = (bag) => Object.entries(bag).map(([key, on]) => ({ key, on, type: key.split(":")[0] }));
  return {
    // **Both rows are the window the app is scheduling** — this month and the one after it — with the
    // days the app has written down against the titles, soonest first. A title whose day has left the
    // window is no longer on a schedule: what came in before it is a title like any other, and what
    // went out before it is out of the app for good.
    leaving: rows(all.leaving)
      .filter((r) => r.on >= monthStart(monthOf()) && r.on <= scheduleEnd())
      .sort((a, b) => a.on.localeCompare(b.on)),
    arriving: rows(all.arrived)
      .filter((r) => r.on >= monthStart(monthOf()) && r.on <= scheduleEnd())
      .sort((a, b) => a.on.localeCompare(b.on)),
    today: now,
    // **The shelf itself, in the report.** Which month's turn this is, the month the schedule reaches,
    // how much of the catalogue the service carries and how many titles a turn moves — the numbers the
    // whole feature is.
    shelf: {
      month: monthOf(),
      through: scheduleEnd().slice(0, 7),
      share: SHELF_SHARE,
      turn: SHELF_TURN,
      carried: rows(all.arrived).length,
    },
  };
}
