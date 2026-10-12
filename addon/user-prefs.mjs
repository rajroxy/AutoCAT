/**
 * General preferences that are not a provider key or a catalog choice.
 *
 * Everything here is small, local and user-owned — whether search-on-play runs, whether
 * the Sources panel shows its summary line — and it lives in `user-preferences.json` so it
 * survives a restart. Nothing here is a secret, and nothing here is regenerated content:
 * extracted URLs, search answers and cached metadata are deliberately **not** stored
 * anywhere, because a stream URL expires and a cached row only ever goes stale.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopedFile } from "./scope.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_FILE = process.env.NUVIO_PREFS_FILE || path.join(__dirname, "user-preferences.json");

/* A preference belongs to the person watching — see `scope.mjs`. */
const file = () => scopedFile(BASE_FILE, "user-preferences");

const DEFAULTS = {
  // Run the Custom Websites search when Play is pressed.
  searchOnPlay: true,
  // Show "Custom Sites: N streams" above the source list.
  sourcesSummary: true,
  // Remember which Custom Websites category the Settings pane last showed.
  lastCategory: "movies",
  // The resolution Play reaches for when it picks a stream for the title page. "auto"
  // takes the first good stream; a number is a **ceiling** — the highest stream at or
  // below it — so 1080p never hands you a 4K file on a screen that cannot show it.
  quality: "auto",
  // The subtitle language-picker choice is stored with the subtitle settings; this is a
  // place for the few remaining page-level switches.
  showTierBadges: true,
  updated: 0,
};

let cache = null;
let cacheFile = "";

function load() {
  const f = file();
  if (cache && f === cacheFile) return cache;
  cacheFile = f;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    cache = { ...DEFAULTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function persist() {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(load(), null, 2) + "\n");
  } catch {
    /* read-only fs — the in-memory copy still applies for this run */
  }
}

export const getPrefs = () => ({ ...load() });

export function updatePrefs(patch = {}) {
  const next = load();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (typeof DEFAULTS[k] === "boolean") next[k] = v === true || v === "true";
    else next[k] = v;
  }
  next.updated = Date.now();
  cache = next;
  persist();
  return getPrefs();
}
