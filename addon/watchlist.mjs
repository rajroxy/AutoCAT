/**
 * The watchlist — pinned titles, and how far you are with them.
 *
 * AutoCAT's watchlist is not a TMDB catalog: it is the set of titles *you* pinned.
 * So it is stored here, on the server, and served back through the ordinary
 * catalog route. That is what makes it behave like every other row — the app
 * renders it with the same strip, it pages the same way, and the addon publishes
 * it in its manifest for AutoCAT to show too.
 *
 * A pinned title moves through three states:
 *
 *   planned   → Plan to Watch   (pinned, not started)
 *   watching  → Watching        (started)
 *   watched   → Watched         (finished)
 *
 * The store is `addon/watchlist.json` (git-ignored, created at runtime; the path
 * can be overridden with AUTOCAT_WATCHLIST_FILE so tests never touch the real one).
 *
 * A title is keyed by `type + id`: TMDB numbers movies and shows in the same id
 * space, so `tmdb:550` is both a film and a series and they must not collide.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopedFile, setFallbackScope } from "./scope.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_FILE = process.env.AUTOCAT_WATCHLIST_FILE || path.join(__dirname, "watchlist.json");

/* ============================================================================
   **One watchlist per profile.**
   ----------------------------------------------------------------------------
   The store was one file for the machine, so switching profile showed the same
   pins: Profile 2 opened on Profile 1's plan-to-watch, and pinning something in
   one row put it in the other's. A profile is a person, and what a person has
   watched is theirs.

   The file is chosen by the **scope** the caller asks with (`?who=<id>`, sent by
   the app for the profile that is on): `watchlist.<who>.json`. No `who` — a
   Stremio/AutoCAT client reading the addon, a script, a test — is the plain
   `watchlist.json` it always was, so nothing outside the app changes.

   The first scoped caller **inherits the file that was there**: an install from
   before this change had its pins in the plain file, and its profile is the one
   making the first request. A marker keeps that inheritance to a single profile,
   so a third profile starts with an empty watchlist rather than a copy of the
   first one's.
   ============================================================================ */
/**
 * **The file this store is pointed at, asked for *now*.** See the same note in
 * `settings.mjs` and the reason for it in `scope.mjs`.
 */
const file = () => {
  const next = scopedFile(BASE_FILE, "watchlist");
  if (next !== cacheFile) {
    cacheFile = next;
    cache = null;
  }
  return next;
};

/** Kept for callers that are not a request. */
export const setScope = (who) => { setFallbackScope(who); };

export const STATES = ["planned", "watching", "watched"];

/** The label each state is published under, in the app and in the manifest. */
export const STATE_LABEL = { planned: "Plan to Watch", watching: "Watching", watched: "Watched" };

export const isState = (value) => STATES.includes(String(value || ""));

const keyOf = (item) => `${item?.type === "movie" ? "movie" : "series"}:${String(item?.id || "")}`;

/**
 * Only the fields the app draws are kept — a pin is not a copy of TMDB.
 *
 * Exported because a custom row stores the same shape: a stored title is the
 * same object whether it sits in a watch state or in a row you built yourself.
 */
export function cleanItem(item, state) {
  const id = String(item?.id || "");
  if (!id) return null;
  const out = { id, type: item.type === "movie" ? "movie" : "series", name: String(item.name || "Untitled") };
  if (state) out.state = state;
  for (const field of ["poster", "background", "releaseInfo", "imdbRating", "description"]) {
    if (item[field]) out[field] = String(item[field]);
  }
  if (item.hasBetterPoster) out.hasBetterPoster = true;
  // A calendar plan is a plan about a date, and the app draws the day under the poster —
  // so the date is one of the fields worth keeping. It is absent on every other pin.
  if (item.releaseDate) out.releaseDate = String(item.releaseDate);
  out.addedAt = item.addedAt || new Date().toISOString();
  out.updatedAt = new Date().toISOString();
  return out;
}

/** Only the fields the app draws are kept — a pin is not a copy of TMDB. */
const clean = (item, state) => cleanItem(item, state);

let cache = null;
let cacheFile = BASE_FILE;

function load() {
  // The cache belongs to one profile's file — resolve which profile this is *first*.
  const f = file();
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    const items = Array.isArray(raw) ? raw : raw?.items;
    for (const item of items || []) {
      if (item && item.id && isState(item.state)) cache.set(keyOf(item), { ...item });
    }
  } catch {
    /* no file yet — an empty watchlist */
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify({ items: [...load().values()] }, null, 2) + "\n");
  } catch {
    /* read-only fs — the in-memory copy still works for this run */
  }
}

/** Every pinned title, newest activity first. `state` narrows it to one row. */
export function list(state) {
  const items = [...load().values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return state ? items.filter((i) => i.state === state) : items;
}

/**
 * The keys of every title in the **Watched** state.
 *
 * The app shows watched titles in exactly two places — the Watchlist card's Watched row
 * and a Custom row you put them in — so every *other* row and every search has to be able
 * to say "not this one". The keys are the same shape the store uses (`movie:<id>`), which
 * is also the shape a TMDB meta arrives in, so nothing has to be re-derived.
 */
export function watchedKeys() {
  // **Watching counts too.** A title you have started belongs in the Watching row and
  // nowhere else, exactly as a finished one belongs in Watched — so both states are
  // hidden from every other row and from search. Only a title still *planned* keeps
  // showing up around the app, which is the point of planning it.
  return [...load().values()].filter((i) => i.state === "watched" || i.state === "watching").map((i) => keyOf(i));
}

/** How many titles sit in each state — what the Watchlist card reports. */
export function counts() {
  const out = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const item of load().values()) out[item.state] = (out[item.state] || 0) + 1;
  return out;
}

/**
 * Pin a title into a state. Pinning the state a title is already in removes it —
 * that is what makes the buttons in the app toggle, so a mis-pin is one click to
 * undo rather than a separate unpin flow.
 */
export function pin(item, state) {
  const map = load();
  const key = keyOf(item);
  const next = isState(state) ? clean(item, state) : null;
  if (!next) return { ok: false, message: `unknown state ${state}` };
  if (map.get(key)?.state === next.state) {
    map.delete(key);
    save();
    return { ok: true, removed: true, state: null, counts: counts() };
  }
  map.set(key, next);
  save();
  return { ok: true, removed: false, state: next.state, item: next, counts: counts() };
}

/** Forget a title entirely, whatever state it was in. */
export function unpin(item) {
  const map = load();
  const removed = map.delete(keyOf(item));
  if (removed) save();
  return { ok: true, removed, counts: counts() };
}

/** The stored titles for one row, as catalog metas. */
export function metasFor(state, type, skip = 0, limit = 40) {
  const items = list(state).filter((i) => i.type === type);
  return items.slice(skip, skip + limit).map((i) => ({ ...i }));
}

/** Test/diagnostic helper — drop everything. */
export function clear() {
  cache = new Map();
  save();
}
