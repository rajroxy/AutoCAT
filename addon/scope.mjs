/**
 * **Which profile the work in hand belongs to.**
 *
 * Every store a profile owns — its keys and add-ons (`settings.<who>.json`), its
 * Library (`customrows.<who>.json`), its watchlist, its saved sites, its preferences,
 * its resolver — is a *file per profile*, and the file is chosen from the `who` the
 * caller sends. That choice used to be written into a module variable the moment a
 * request arrived, which is a global: the handler then `await`s (a body to read, a
 * provider to fetch), and **another request for another profile can arrive in that
 * gap and move the variable**. The first request resumes and reads — or writes — the
 * second profile's file. Two tabs, or one tab switching profile while a fetch is in
 * flight, is all it takes for one person's key to land in the other person's app.
 *
 * So the profile is not a variable. It is carried **with the work**: the request
 * handler runs inside `withScope(who, …)`, `AsyncLocalStorage` keeps that value
 * attached across every `await` inside it, and each store asks for its file *at the
 * moment it touches it* (`scopedFile` below) instead of relying on something set
 * earlier. A request that carries no `who` — Stremio reading the addon, a script, the
 * test suite — resolves to the plain file it always used, so nothing outside the app
 * changes.
 *
 * `setFallbackScope` is for the callers that are **not** a request at all: the
 * one-off scripts in `.preview/`, and a shell that imports a store directly. It is
 * the old behaviour, deliberately kept to one place.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

const als = new AsyncLocalStorage();

/** A profile id cannot smuggle a path separator into a file name. */
export const cleanScope = (who) => String(who || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 32);

/** The profile a direct (non-request) caller is acting as — see the note above. */
let fallback = "";

export function setFallbackScope(who) {
  fallback = cleanScope(who);
}

/**
 * Run `fn` with every store pointing at `who`'s files, and at `mode`'s settings.
 *
 * `mode` is `vod` or `iptv` (or `""` for one shared set — see `scopedFileMode`). Only the
 * settings store uses it: the two modes are two ways to use the app, so a Debrid account or
 * a playlist added in one belongs to it, while the Library and the watchlist stay one
 * history across both.
 */
export function withScope(who, fn, mode = "") {
  return als.run({ who: cleanScope(who), mode: cleanScope(mode).toLowerCase() }, fn);
}

/**
 * Point **the work in hand** at `who` from here on.
 *
 * A request is scoped when it arrives, but one route reads the profile out of the POST
 * body instead of the URL, so the scope has to be movable *within* the request. That is
 * what this does — it moves the value the work in hand carries, never a module global,
 * so no other request can see the change.
 */
export function rescope(who) {
  const next = cleanScope(who);
  const store = als.getStore();
  if (store) {
    store.who = next;
    return true;
  }
  fallback = next;
  return true;
}

/** The profile the work in hand belongs to ("" = the plain, unscoped stores). */
export function currentScope() {
  const store = als.getStore();
  return store ? store.who : fallback;
}

/** The mode the work in hand belongs to ("" = VOD and IPTV share one set of settings). */
export function currentMode() {
  const store = als.getStore();
  return store ? store.mode || "" : "";
}

/**
 * The file for `base` in the profile the work in hand belongs to: `settings.json`
 * becomes `settings.<who>.json`.
 *
 * **The first scoped caller inherits the file that was there.** An install from
 * before profiles had their own files had its keys in the plain one, and its profile
 * is the one making the first request. A marker keeps that inheritance to a single
 * profile, so the next profile starts with the defaults rather than a copy of the
 * first one's keys.
 */
/**
 * **The file for one mode's settings.** `settings.you.json` becomes
 * `settings.you-iptv.json`, and the plain, un-moded file stays exactly where it was for
 * callers that name no mode (Stremio reading the addon, the scripts, the tests).
 *
 * **The mode's copy starts as the one you had.** An install that has been using one set of
 * settings gets it in *both* modes the first time each is opened, rather than landing in a
 * fresh app; from there the two go their own way. It is written once — an existing file is
 * never touched.
 */
export function scopedFileMode(base, name, mode) {
  const plain = scopedFile(base, name);
  const clean = cleanScope(mode).toLowerCase();
  if (!clean) return plain;
  const file = plain.replace(/\.json$/, `.${clean}.json`);
  try {
    if (!fs.existsSync(file) && fs.existsSync(plain)) fs.copyFileSync(plain, file);
  } catch {
    /* a read-only fs: the file name is still the right one for this run */
  }
  return file;
}

export function scopedFile(base, name) {
  const who = currentScope();
  if (!who) return base;
  const dir = path.dirname(base);
  const file = path.join(dir, `${name}.${who}.json`);
  try {
    if (fs.existsSync(file)) return file;
    const marker = path.join(dir, `${name}.scope`);
    if (!fs.existsSync(marker) && fs.existsSync(base)) {
      fs.writeFileSync(file, fs.readFileSync(base));
      fs.writeFileSync(marker, `${who}\n`);
    }
  } catch {
    /* a read-only fs: the file name is still the right one for this run */
  }
  return file;
}
