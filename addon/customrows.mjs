/**
 * Custom rows — the row that sits after the Watchlist card's three states.
 *
 * The first three rows of the Watchlist card are the states a pinned title moves
 * through (Plan to Watch → Watching → Watched), and they fill themselves as you
 * pin things. The row after them is deliberately different: it is a **custom
 * row**, and it holds exactly the titles you put in it. Nothing is added for you
 * and nothing is removed, so it is the place for the handful of things you want
 * to get to without calling them "Plan to Watch".
 *
 * Like the watchlist it lives on the server (`addon/customrows.json` — git
 * ignored, created at runtime, overridable with `AUTOCAT_CUSTOM_FILE` so tests
 * never touch the real file) and is served through the ordinary catalog route,
 * so it pages, scrolls and publishes in the manifest exactly like every other
 * row, and AutoCAT shows it too.
 *
 * A stored title is keyed by `type + id`, the same key the watchlist uses: TMDB
 * numbers films and shows in one id space, so the type has to be part of it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopedFile, setFallbackScope } from "./scope.mjs";
import { cleanItem } from "./watchlist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_FILE = process.env.AUTOCAT_CUSTOM_FILE || path.join(__dirname, "customrows.json");

/* **One Library per profile.** The rows you built and what you put in them belong to the
   person watching, not to the machine — see the same note in `watchlist.mjs`, which this
   follows exactly: `customrows.<who>.json`, the plain file for callers that send no
   `who` (Stremio, a script), and the first scoped caller inheriting what was there. */
/**
 * **The file this store is pointed at, asked for *now*.** See the same note in
 * `settings.mjs` and the reason for it in `scope.mjs`.
 */
const file = () => {
  const next = scopedFile(BASE_FILE, "customrows");
  if (next !== cacheFile) {
    cacheFile = next;
    cache = null;
    metalist = null;
  }
  return next;
};

/** Kept for callers that are not a request. */
export const setScope = (who) => { setFallbackScope(who); };

/** The row the Watchlist card publishes after its three state rows. */
export const DEFAULT_ROW = "add-cards";

/**
 * **How many custom rows the Custom card can hold.**
 *
 * The card's rows are published from a fixed set of ids (`add-cards`, `add-cards-2`, …)
 * and each request names the ones that exist, in the user's order. A fixed ceiling is
 * what keeps a row's *id* stable while its *name* changes: a catalog id in this app is
 * built from the entry's row, so renaming a row never breaks the row that is already
 * being read (or published to AutoCAT).
 */
export const MAX_ROWS = 6;
export const rowIdFor = (index) => (index === 0 ? DEFAULT_ROW : `${DEFAULT_ROW}-${index + 1}`);

const keyOf = (item) => `${item?.type === "movie" ? "movie" : "series"}:${String(item?.id || "")}`;

let cache = null;
let cacheFile = BASE_FILE;
/** The custom card's rows: `[{ id, name, order }]`, in the user's order. */
let metalist = null;

function load() {
  // The cache belongs to one profile's file — resolve which profile this is *first*.
  const f = file();
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    const rows = raw?.rows && typeof raw.rows === "object" ? raw.rows : {};
    for (const [id, items] of Object.entries(rows)) {
      const kept = new Map();
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.id) kept.set(keyOf(item), { ...item });
      }
      cache.set(id, kept);
    }
  } catch {
    /* no file yet — every custom row is empty */
  }
  return cache;
}

/**
 * The rows the Custom card offers.
 *
 * A file written before rows had names holds no metadata, so the first row is named from
 * the card itself (`add-cards` → `My List`) and every other row that holds something gets
 * its id for a name. The **calendar** row (`calendar-plans`) is deliberately not part of
 * this list: it is filled by the calendar, not by hand, so it never appears in Settings
 * beside the rows you manage.
 */
function loadMeta() {
  // Resolve the profile's file first: the cache belongs to one file (see `load`).
  const f = file();
  if (metalist) return metalist;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    /* no file yet */
  }
  const listed = Array.isArray(raw?.meta) ? raw.meta.filter((r) => r && r.id) : [];
  const seen = new Set(listed.map((r) => String(r.id)));
  const next = listed.map((r, i) => ({ id: String(r.id), name: String(r.name || "").slice(0, 40) || "My List", order: Number(r.order) || i }));
  if (!seen.has(DEFAULT_ROW)) next.unshift({ id: DEFAULT_ROW, name: "My List", order: -1 });
  // Any row that holds titles but predates the metadata keeps its contents and gets a row.
  for (const id of load().keys()) {
    if (id === CAL_PLANS || seen.has(id) || next.some((r) => r.id === id)) continue;
    next.push({ id, name: id, order: next.length });
  }
  metalist = next.slice(0, MAX_ROWS).map((r, i) => ({ ...r, order: i }));
  return metalist;
}

/** The calendar's own row: never in Settings, still a place titles can live. */
const CAL_PLANS = "calendar-plans";

function saveMeta() {
  const rows = {};
  for (const [id, items] of load()) rows[id] = [...items.values()];
  try {
    fs.writeFileSync(file(), JSON.stringify({ rows, meta: loadMeta() }, null, 2) + "\n");
  } catch {
    /* read-only fs */
  }
}

function save() {
  const rows = {};
  for (const [id, items] of load()) rows[id] = [...items.values()];
  try {
    fs.writeFileSync(file(), JSON.stringify({ rows, meta: loadMeta() }, null, 2) + "\n");
  } catch {
    /* read-only fs — the in-memory copy still works for this run */
  }
}

/* ------------------------------------------------------------------ the rows */

/** Every custom row, in order, with how many titles it holds — empty ones included. */
export function listRows() {
  return loadMeta().map((r, i) => ({ ...r, order: i, count: (load().get(r.id) || new Map()).size }));
}

/** Add one row, named. Refused past the card's ceiling. */
export function addRow(name = "") {
  const all = loadMeta();
  if (all.length >= MAX_ROWS) return { ok: false, message: `The card holds ${MAX_ROWS} rows already.` };
  const label = String(name || "").trim().slice(0, 40) || `Row ${all.length + 1}`;
  // The first free id: stable, and never reused for a row that was deleted.
  const used = new Set(all.map((r) => r.id));
  let id = "";
  for (let i = 0; i < MAX_ROWS; i += 1) {
    if (!used.has(rowIdFor(i))) { id = rowIdFor(i); break; }
  }
  if (!id) return { ok: false, message: "No free row id left." };
  all.push({ id, name: label, order: all.length });
  metalist = all.map((r, i) => ({ ...r, order: i }));
  load().set(id, new Map());
  saveMeta();
  return { ok: true, id, name: label, rows: listRows(), message: `Added “${label}”.` };
}

export function renameRow(id, name) {
  const all = loadMeta();
  const row = all.find((r) => r.id === String(id || ""));
  if (!row) return { ok: false, message: "That row does not exist." };
  const label = String(name || "").trim().slice(0, 40);
  if (!label) return { ok: false, message: "A row needs a name." };
  row.name = label;
  metalist = all;
  saveMeta();
  return { ok: true, rows: listRows(), message: `Renamed to “${label}”.` };
}

/** Delete a row — and the titles in it, which is the whole of what it held. */
export function deleteRow(id) {
  const all = loadMeta();
  const at = all.findIndex((r) => r.id === String(id || ""));
  if (at < 0) return { ok: false, message: "That row does not exist." };
  if (all.length <= 1) return { ok: false, message: "The card needs at least one row." };
  const [gone] = all.splice(at, 1);
  const held = (load().get(gone.id) || new Map()).size;
  load().delete(gone.id);
  metalist = all.map((r, i) => ({ ...r, order: i }));
  saveMeta();
  return { ok: true, rows: listRows(), message: `Deleted “${gone.name}”${held ? ` and the ${held} title${held === 1 ? "" : "s"} it held` : ""}.` };
}

/** Move a row one place up (`delta: -1`) or down. */
export function moveRow(id, delta = 0) {
  const all = loadMeta();
  const at = all.findIndex((r) => r.id === String(id || ""));
  if (at < 0) return { ok: false, message: "That row does not exist." };
  const to = Math.max(0, Math.min(all.length - 1, at + (delta > 0 ? 1 : -1)));
  if (to === at) return { ok: true, rows: listRows() };
  const [row] = all.splice(at, 1);
  all.splice(to, 0, row);
  metalist = all.map((r, i) => ({ ...r, order: i }));
  saveMeta();
  return { ok: true, rows: listRows() };
}

/** The rows that hold something, with how many titles each one holds. */
export function rows() {
  return [...load().entries()]
    .map(([id, items]) => ({ id, count: items.size }))
    .filter((r) => r.count > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** How many titles each custom row holds. */
export function counts() {
  return Object.fromEntries(rows().map((r) => [r.id, r.count]));
}

/**
 * **What is inside each row, as title keys.** The app filters a title out of Home and Search
 * once it belongs to you — a pin does it, and so does a Library row — and that filter needs
 * the *keys*, not the counts. Sent with the settings so the screen behind a title updates the
 * moment the title is put in a row, instead of at the next boot.
 */
export function keys() {
  return Object.fromEntries([...load().entries()].map(([row, map]) => [row, [...map.keys()]]));
}

/** Every stored title, tagged with the row it is in — what the app reads. */
export function items() {
  return [...load().entries()].flatMap(([row, map]) => [...map.values()].map((item) => ({ ...item, row })));
}

/** One row's titles, newest added first. */
export function list(rowId = DEFAULT_ROW) {
  const items = [...(load().get(String(rowId || DEFAULT_ROW))?.values() || [])];
  return items.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

const write = (rowId, map) => {
  const all = load();
  all.set(String(rowId || DEFAULT_ROW), map);
  save();
};

/**
 * Put a title in a row — or take it out again when it is already there.
 *
 * Toggling is what makes the modal's one button work as both "add" and "remove",
 * so a mis-click is one click to undo rather than a separate flow.
 */
export function add(rowId, item) {
  const id = String(rowId || DEFAULT_ROW);
  const next = cleanItem(item);
  if (!next) return { ok: false, message: "an item needs an id" };
  const map = new Map(load().get(id) || []);
  const key = keyOf(next);
  if (map.has(key)) {
    map.delete(key);
    write(id, map);
    return { ok: true, removed: true, inRow: false, count: map.size };
  }
  // Adding to a row that already holds it under another state keeps the state
  // off: a custom row is a list of titles, not a progress tracker.
  map.set(key, next);
  write(id, map);
  return { ok: true, removed: false, inRow: true, item: next, count: map.size };
}

/** Forget a title, whatever state it is in. */
export function remove(rowId, item) {
  const id = String(rowId || DEFAULT_ROW);
  const map = new Map(load().get(id) || []);
  const removed = map.delete(keyOf(item));
  if (removed) write(id, map);
  return { ok: true, removed, inRow: false, count: map.size };
}

/** The stored titles for one row, as catalog metas. */
export function metasFor(rowId, type, skip = 0, limit = 40) {
  return list(rowId)
    .filter((i) => i.type === type)
    .slice(skip, skip + limit)
    .map((i) => ({ ...i }));
}

/**
 * Empty one row, keeping the others.
 *
 * Settings → Custom Rows offers this per row: taking a card out one at a time is fine
 * for one card, and the wrong tool for clearing the list you have stopped using.
 */
export function clearRow(rowId = DEFAULT_ROW) {
  const id = String(rowId || DEFAULT_ROW);
  const had = (load().get(id) || new Map()).size;
  write(id, new Map());
  return { ok: true, row: id, removed: had, count: 0 };
}

/** Test/diagnostic helper — drop everything. */
export function clear() {
  cache = new Map();
  save();
}
