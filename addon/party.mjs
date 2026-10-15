/**
 * **Watch Along — the party around a title, and the talk about it.**
 *
 * Watching something alongside someone is two things the app can actually hold: *when* you are
 * both in front of it — a **watch party** — and *what you said about it* — the **discussion**.
 * Both live here, on the server, so they survive a reload and so two people on the same app
 * can see the same room.
 *
 * **The store is one file for the machine, not one per profile.** That is the point of a party:
 * a code you can read out loud is worth nothing if the other person's profile cannot find it.
 * So `party.json` holds every room, a room names the profile that started it, and `?code=`
 * finds a room from anywhere that can reach this app (the LAN, a second profile, a phone on
 * the same Wi-Fi). The **notes** are per title and belong to the room's thread, so the talk
 * stays with the title wherever a party is started later.
 *
 * A room is not an account: joining says *I am watching too*, and nothing else about you is
 * kept. A note keeps the name it was written under, because a discussion is other people
 * talking and "someone said" is not a discussion.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanItem } from "./watchlist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.AUTOCAT_PARTY_FILE || path.join(__dirname, "party.json");

/** A code is read out loud, so 0/O and 1/I are not in it. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
/**
 * **One title, one key — whatever shape the id arrives in.**
 *
 * The app's metas carry their provider (`tmdb:550`), a Stremio catalog's do not (`550`), and a
 * series is numbered in TMDB's own id space beside the films — so `movie:tmdb:550` and
 * `movie:550` name the same picture and a series with the same number does not. The key is
 * normalised to `type:id` here, which is what makes a party started from a title page the same
 * party the addon's own catalog would open.
 */
const cleanKey = (value) => {
  const raw = String(value || "");
  const type = /^series/i.test(raw) ? "series" : "movie";
  const id = raw.replace(/^[a-z]+:/i, "").replace(/^[a-z]+:/i, "");
  return `${type}:${id.replace(/[^0-9a-z_-]/gi, "")}`.slice(0, 64);
};
const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 600);
const cleanWho = (value) => String(value || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
const nameOf = (value) => String(value || "").replace(/[<>]/g, "").trim().slice(0, 40) || "Someone";
const now = () => new Date().toISOString();

const EMPTY = { threads: {} };
let cache = null;

function load() {
  if (cache) return cache;
  cache = EMPTY;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = { threads: raw && typeof raw.threads === "object" && raw.threads ? raw.threads : {} };
  } catch {
    /* no file yet — nothing has been watched along */
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(FILE, `${JSON.stringify(load(), null, 2)}\n`);
  } catch {
    /* a read-only folder: the copy in memory still works for this run */
  }
}

/** The thread for one title, made on first use. `title` is only filled the first time. */
function thread(key, title) {
  const k = cleanKey(key);
  if (!k) return null;
  const store = load();
  let entry = store.threads[k];
  if (!entry) {
    entry = { key: k, title: title ? cleanItem(title) : null, room: null, notes: [] };
    store.threads[k] = entry;
  } else if (!entry.title && title) {
    entry.title = cleanItem(title);
  }
  return entry;
}

/** What the app draws: the room for a title, and the talk under it. */
export function state(key, codeOrEmpty = "") {
  const wanted = cleanKey(key);
  const store = load();
  const entry = wanted && store.threads[wanted] ? store.threads[wanted] : (codeOrEmpty ? byCode(codeOrEmpty) : null);
  return {
    ok: true,
    key: entry?.key || wanted,
    title: entry?.title || null,
    room: publicRoom(entry),
    notes: (entry?.notes || []).slice(-60),
  };
}

/** A room as the app reads it — the joined map as a list, because that is what it draws. */
function publicRoom(entry) {
  if (!entry?.room) return null;
  const room = entry.room;
  return {
    code: room.code,
    startedAt: room.startedAt,
    host: room.host,
    hostName: room.hostName,
    live: room.joined && Object.keys(room.joined).length > 0,
    joined: Object.entries(room.joined || {}).map(([who, at]) => ({ who, name: nameOf((room.names || {})[who]), at })),
  };
}

/** The room a code names, from anywhere in the file. */
export function byCode(value) {
  const wanted = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (wanted.length < 4) return null;
  for (const entry of Object.values(load().threads)) {
    if (entry?.room?.code === wanted) return entry;
  }
  return null;
}

/**
 * **Start a party.** One press, one code, and whoever you are watching with joins with it.
 * Starting again re-codes the room rather than making a second one: a title has one party.
 */
export function start({ key, title, who = "", name = "" } = {}) {
  const entry = thread(key, title);
  if (!entry) return { ok: false, text: "name a title first" };
  const me = cleanWho(who) || "you";
  entry.room = {
    code: code(),
    startedAt: now(),
    host: me,
    hostName: nameOf(name || "You"),
    joined: { [me]: now() },
    names: { [me]: nameOf(name || "You") },
  };
  save();
  return { ok: true, ...state(entry.key) };
}

/** **Join.** Says *I am watching too* — the one thing a party needs from someone. */
export function join({ key, who = "", name = "" } = {}) {
  const entry = load().threads[cleanKey(key)];
  if (!entry?.room) return { ok: false, text: "no party is on for this title" };
  const me = cleanWho(who) || "you";
  entry.room.joined[me] = now();
  entry.room.names = { ...(entry.room.names || {}), [me]: nameOf(name || "You") };
  save();
  return { ok: true, ...state(entry.key) };
}

/** Leave — the room stays, with whoever is still in it. */
export function leave({ key, who = "" } = {}) {
  const entry = load().threads[cleanKey(key)];
  if (!entry?.room) return { ok: false, text: "no party is on for this title" };
  delete entry.room.joined[cleanWho(who) || "you"];
  save();
  return { ok: true, ...state(entry.key) };
}

/** End it for everyone: the code stops working, the talk stays. */
export function end({ key, code: given = "" } = {}) {
  const entry = load().threads[cleanKey(key)] || byCode(given);
  if (!entry?.room) return { ok: false, text: "no party is on for this title" };
  entry.room = null;
  save();
  return { ok: true, ...state(entry.key) };
}

/** Say something about the title. The name is kept: a talk is people talking. */
export function note({ key, title, text, who = "", name = "" } = {}) {
  const said = cleanText(text);
  if (!said) return { ok: false, text: "write something first" };
  const entry = thread(key, title);
  if (!entry) return { ok: false, text: "name a title first" };
  entry.notes.push({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, who: cleanWho(who) || "you", name: nameOf(name || "You"), text: said, at: now() });
  // Sixty notes is a conversation; a hundred is a log nobody scrolls.
  if (entry.notes.length > 60) entry.notes = entry.notes.slice(-60);
  save();
  return { ok: true, ...state(entry.key) };
}

/** Test/diagnostic helper — drop everything. */
export function clear() {
  cache = { threads: {} };
  save();
}
