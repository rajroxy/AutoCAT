/**
 * **The players you actually watch in, wired to this app.**
 *
 * Mode 2 is *watch elsewhere, track here*: Kodi, Plex, Stremio, Nuvio, Infuse and the rest stay
 * the players, and this app is the dashboard. A dashboard that only shows what you pinned by hand
 * is not tracking anything, though — the app has to be **told** what played. That is what this
 * store is: one line per player you connected, and one **ingest address** the player itself calls
 * when something starts or finishes.
 *
 * The address is this app's own, with this profile's token on it:
 *
 *   POST /players/watch.json   { "token": "…", "title": "…", "type": "movie", "state": "watching" }
 *   GET  /players/watch.json?token=…&title=…&state=watched        (for anything that can only call a URL)
 *
 * Nothing is invented when a report lands: a title named only by its name is looked up in the
 * catalogue (TMDB) and, if it is not there, the report is refused with the reason. What it files is
 * an ordinary **pin** — `plan`, `watching` or `watched` — so a watch reported by a player appears on
 * the Activity page, in the Library card's rows and in the Watched filter exactly like one you
 * pinned in the app, because it *is* one. `source` is kept alongside it so the Activity page can say
 * which player it came from.
 *
 * The store is per profile, like the watchlist and the settings (`players.<who>.json`), and it is
 * git-ignored. `AUTOCAT_PLAYERS_FILE` points it somewhere else for tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { scopedFile, setFallbackScope } from "./scope.mjs";
import { cleanItem, pin as pinWatch } from "./watchlist.mjs";
import { get, hasKey, setKey, toMeta } from "./tmdb.mjs";
import { tmdbKey } from "./settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_FILE = process.env.AUTOCAT_PLAYERS_FILE || path.join(__dirname, "players.json");

/**
 * **Players the app knows by name**, offered as rows before you type anything.
 *
 * The address is *optional*: what makes a connection work is pasting this app's ingest address into
 * the player, and the player's own address here is only for the app's record of where it watches.
 */
export const KNOWN_PLAYERS = [
  ["stremio", "Stremio", "Add the app as an add-on, or point Stremio's webhook at the ingest address — Stremio reports what you start and finish."],
  ["nuvio", "Nuvio", "Paste the ingest address as Nuvio's sync endpoint; every title you play is filed here as watching, then watched."],
  ["kodi", "Kodi", "Kodi's own scrobbler can call a URL — that URL is the ingest address below."],
  ["plex", "Plex", "Point Plex's webhook at the ingest address."],
  ["jellyfin", "Jellyfin", "Jellyfin's webhook plugin takes the ingest address as its target."],
  ["infuse", "Infuse", "Infuse can POST to a URL when a title finishes."],
  ["vlc", "VLC", "For anything that can only open a link, the GET form of the address works."],
  ["other", "Something else", "Any player that can POST JSON or call a URL can report here — the shape is in the description above the box."],
];

const MAX_PLAYERS = 8;
const MAX_EVENTS = 12;

let cache = null;
let cacheFile = "";

const file = () => {
  const next = scopedFile(BASE_FILE, "players");
  if (next !== cacheFile) {
    cacheFile = next;
    cache = null;
  }
  return next;
};

/** Kept for callers that are not a request. */
export const setScope = (who) => { setFallbackScope(who); };

const empty = () => ({ token: "", players: [], events: [] });

function load() {
  file();
  if (cache) return cache;
  cache = empty();
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    cache = {
      token: typeof raw?.token === "string" ? raw.token : "",
      players: Array.isArray(raw?.players) ? raw.players.filter((p) => p && p.id).map((p) => ({
        id: String(p.id),
        name: String(p.name || p.id),
        url: String(p.url || ""),
        on: p.on !== false,
        lastAt: String(p.lastAt || ""),
        lastTitle: String(p.lastTitle || ""),
        count: Number(p.count) || 0,
      })) : [],
      events: Array.isArray(raw?.events) ? raw.events.slice(0, MAX_EVENTS) : [],
    };
  } catch {
    /* no file yet — nothing is connected */
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2) + "\n");
  } catch {
    /* read-only fs — the in-memory copy still works for this run */
  }
}

/** The token the ingest address carries. Made on first use, so a fresh install has an address at once. */
export function token() {
  const state = load();
  if (!state.token) {
    state.token = randomBytes(18).toString("base64url");
    save();
  }
  return state.token;
}

/** A new token — the old address stops working, which is the point of rotating it. */
export function rotate() {
  const state = load();
  state.token = randomBytes(18).toString("base64url");
  save();
  return state.token;
}

/** One player row, as the pane draws it. */
const publicPlayer = (p) => ({ id: p.id, name: p.name, url: p.url, on: p.on !== false, lastAt: p.lastAt || "", lastTitle: p.lastTitle || "", count: p.count || 0 });

/** Everything the Settings pane needs, in one answer. */
export function state() {
  const store = load();
  return {
    token: token(),
    players: store.players.map(publicPlayer),
    events: store.events.map((e) => ({ ...e })),
    known: KNOWN_PLAYERS.map(([id, name, hint]) => ({ id, name, hint })),
    max: MAX_PLAYERS,
  };
}

/** Connect one. Re-connecting the same player updates its address rather than adding a second row. */
export function connect(id, { name = "", url = "" } = {}) {
  const store = load();
  const slug = String(id || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 32);
  if (!slug) return { ok: false, error: "A player needs a name." };
  const known = KNOWN_PLAYERS.find(([k]) => k === slug);
  const held = store.players.find((p) => p.id === slug);
  if (!held && store.players.length >= MAX_PLAYERS) {
    return { ok: false, error: `This profile holds ${MAX_PLAYERS} players already — remove one first.` };
  }
  const row = {
    id: slug,
    name: String(name || known?.[1] || slug).slice(0, 40),
    url: String(url || "").trim().slice(0, 400),
    on: true,
    lastAt: held?.lastAt || "",
    lastTitle: held?.lastTitle || "",
    count: held?.count || 0,
  };
  store.players = held ? store.players.map((p) => (p.id === slug ? row : p)) : [...store.players, row];
  save();
  return { ok: true, ...state() };
}

/** Take one away. The token stays: other players may be using the same address. */
export function remove(id) {
  const store = load();
  const before = store.players.length;
  store.players = store.players.filter((p) => p.id !== String(id || ""));
  if (store.players.length !== before) save();
  return { ok: true, ...state() };
}

/** Switch one on or off. Off, its reports are refused — the address keeps working for the others. */
export function setOn(id, on) {
  const store = load();
  store.players = store.players.map((p) => (p.id === String(id || "") ? { ...p, on: on !== false } : p));
  save();
  return { ok: true, ...state() };
}

const STATE_WORDS = {
  plan: "planned", planned: "planned", "plan to watch": "planned", watchlist: "planned",
  start: "watching", started: "watching", watching: "watching", playing: "watching", play: "watching",
  finish: "watched", finished: "watched", watched: "watched", complete: "watched", completed: "watched", stop: "watched",
};

const stateOf = (word) => STATE_WORDS[String(word || "").trim().toLowerCase()] || "";

/**
 * **A report from a player, filed as a pin.**
 *
 * The title may arrive as an id (`tmdb:…`, an IMDb id) or as a name and a year — a name is looked
 * up in the catalogue, and nothing is filed when the catalogue does not know it. The answer says
 * which of the two happened and why, because a webhook that silently does nothing is impossible to
 * debug from the other end.
 */
export async function report({ token: given = "", title = "", year = "", type = "movie", state: word = "watched", id = "", imdb = "", player = "" } = {}) {
  const store = load();
  if (!store.token || String(given) !== store.token) {
    return { ok: false, error: "That token is not this profile's — copy the ingest address from Settings → Players again." };
  }
  const connected = store.players.find((p) => p.on !== false);
  if (!store.players.length) {
    return { ok: false, error: "No player is connected on this profile yet — add one in Settings → Players." };
  }
  if (!connected) return { ok: false, error: "Every connected player is switched off." };
  const wanted = stateOf(word) || "watched";
  const media = String(type || "").toLowerCase().includes("ser") || String(type || "").toLowerCase() === "tv" ? "series" : "movie";

  let item = null;
  const tmdbId = String(id || "").replace(/^tmdb:/, "");
  if (/^\d+$/.test(tmdbId)) {
    item = { id: `tmdb:${tmdbId}`, type: media, name: String(title || "") };
  } else if (String(imdb || "").startsWith("tt")) {
    setKey(tmdbKey());
    if (hasKey()) {
      try {
        const found = await get(`/find/${encodeURIComponent(String(imdb))}`, { external_source: "imdb_id" });
        const hit = media === "series" ? found?.tv_results?.[0] : found?.movie_results?.[0];
        if (hit) item = toMeta(hit, media);
      } catch {
        /* the name is the fallback */
      }
    }
  }
  if (!item && title) {
    setKey(tmdbKey());
    if (!hasKey()) {
      return { ok: false, error: "This app has no TMDB key, so a title sent by name cannot be looked up. Send an id (`tmdb:550`) instead." };
    }
    try {
      const found = await get(`/search/${media === "series" ? "tv" : "movie"}`, { query: String(title), ...(year ? { year: String(year) } : {}) });
      const hit = (found?.results || [])[0];
      if (hit) item = toMeta(hit, media);
    } catch (err) {
      return { ok: false, error: `The catalogue could not be searched — ${err.message}` };
    }
  }
  if (!item) {
    return { ok: false, error: `The catalogue does not know “${String(title || id || "").slice(0, 60)}”. Send an id (\`tmdb:550\`), or the exact name.` };
  }
  // **The pin, with the player's name on it.** `cleanItem` keeps the fields the app draws; `source`
  // is the one extra, and it is what makes the Activity page able to say where the watch came from.
  const filed = cleanItem({ ...item, source: String(player || store.players[0]?.name || "A player").slice(0, 40) }, wanted);
  const pinned = pinWatch(filed, wanted);
  if (pinned.ok === false) return { ok: false, error: pinned.message || "That state is not one of the three." };

  const at = new Date().toISOString();
  const name = pinned.removed ? (store.players[0]?.name || "A player") : (player || store.players[0]?.name || "A player");
  store.events = [{ at, title: filed.name, type: filed.type, state: wanted, player: name }, ...store.events].slice(0, MAX_EVENTS);
  store.players = store.players.map((p, index) => {
    const mine = player ? p.name.toLowerCase() === String(player).toLowerCase() : index === store.players.findIndex((x) => x.on !== false);
    return mine ? { ...p, lastAt: at, lastTitle: filed.name, count: (p.count || 0) + 1 } : p;
  });
  save();
  return { ok: true, filed: { id: filed.id, type: filed.type, name: filed.name, state: wanted, source: filed.source }, removed: Boolean(pinned.removed) };
}

/** Test/diagnostic helper — drop everything this profile has connected. */
export function clear() {
  cache = empty();
  save();
}
