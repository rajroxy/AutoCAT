/**
 * **Nuvio providers, on the server.**
 *
 * Nuvio is not a Stremio add-on and it does not speak the Stremio protocol, which is why it
 * needs its own pane in Settings rather than a row in the Add-ons list: a **repository** is a
 * plain GitHub folder holding
 *
 *   manifest.json            an *array* of providers: `{
  // Providers must be there for the player even if Settings was never opened.
  await seed(); id, name, filename, supportedTypes, … }`
 *   providers/<name>.js      the provider itself, CommonJS, exporting `getStreams(…)`
 *
 * and a provider is asked with the **TMDB id** — the same id this app already holds for every
 * title it shows:
 *
 *   getStreams(tmdbId, "movie" | "tv", season, episode)  →  [ { name, title, url, quality, headers } ]
 *
 * That is a better fit here than an add-on is (no IMDb lookup, no `/stream/…` endpoint), so a
 * provider is run directly for the title the player asked about and its rows are merged into
 * the same Sources drawer as everything else.
 *
 * ## Where this runs
 *
 * On the server, like every other source: the page cannot call another host's script and run
 * it (CSP, CORS), and a provider is a file of JavaScript rather than a URL to fetch JSON from.
 * In the APK and the packaged desktop app this is the same module running in the on-device
 * Node runtime — see `pluginvm.mjs` for the sandbox it runs in.
 *
 * Nothing is stored but the repositories themselves and which of their providers is switched
 * on; the provider files are read once and kept for the run (see `sources`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoBasesDeep } from "./sources.mjs";
import { exportedFunction, loadProvider, MAX_SOURCE_BYTES, ready, toStream, warm, withDeadline } from "./pluginvm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.AUTOCAT_NUVIO_FILE || path.join(__dirname, "nuvio.json");

/** How long one provider may take to answer. Providers scrape; this is a deadline, not a cap. */
const TIMEOUT_MS = Number(process.env.AUTOCAT_NUVIO_TIMEOUT_MS) || 45000;
/** How many providers are asked at once — a list of ten must not open ten swarms of requests. */
const CONCURRENCY = Number(process.env.AUTOCAT_NUVIO_CONCURRENCY) || 5;
/** How long a provider's file is kept before it is read again (a repo fixes a provider now and then). */
const SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

let store = null;
/** `url` → `{ source, at }` — the provider file, as it was last read. */
const sources = new Map();

/** The one shape this file is: a list of repositories, each with its providers. */
const EMPTY = () => ({ repos: [] });

const load = () => {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = { repos: Array.isArray(parsed?.repos) ? parsed.repos : [] };
  } catch {
    store = EMPTY();
  }
  return store;
};

const persist = () => {
  try {
    fs.writeFileSync(FILE, JSON.stringify(load(), null, 2) + "\n");
  } catch {
    /* read-only fs — the in-memory copy still applies for this run */
  }
};

/**
 * **The two repositories the app starts with, and why a vendor's own name is not here.**
 *
 * An empty pane is the state nobody can act on: Nuvio providers are JavaScript files in a GitHub
 * folder, and a person who has never seen one has no address to paste. These two publish the
 * biggest catalogue between them — Phisher's 51 providers and Yoru's 29, with AllMovieLand,
 * AllWish, Anichi, MovieBox, UHDMovies, NetflixMirror and the anime sites among them — so they are
 * read once on a fresh install and every provider in them arrives switched on (see `seed`).
 *
 * Nothing about a seeded repository is special: it can be switched off or removed like any other,
 * and it is not re-added once somebody has made that choice (the seed only runs while the list is
 * **empty**).
 */
export const RECOMMENDED_REPOS = [
  { url: "https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/main/manifest.json", name: "Phisher's Repo" },
  { url: "https://raw.githubusercontent.com/yoruix/nuvio-providers/main/manifest.json", name: "Yoru's Repo" },
];

let seeding = null;

/**
 * **A fresh install gets the recommended repositories.** Called from `state` and from
 * `providerStreams`, so the providers are there whether Settings was ever opened or not; the work
 * is done once per run and only while there is nothing in the list, and a repository that will not
 * load (offline, GitHub hiccup) is skipped in silence — the pane's own Add box is still the way in.
 */
export async function seed() {
  if (load().repos.length) return;
  if (seeding) return seeding;
  seeding = (async () => {
    for (const repo of RECOMMENDED_REPOS) {
      if (load().repos.length >= RECOMMENDED_REPOS.length) break;
      try {
        await addRepo(repo.url, { name: repo.name });
      } catch {
        /* offline, or the repository moved: the pane's Add box still works */
      }
    }
  })();
  await seeding;
  seeding = null;
}

/** The key a provider is known by: its own id inside the repository it came from. */
const keyOf = (repoUrl, plugin) => `${repoUrl}::${plugin.id}`;

/** Trim a repository address to the folder its files live in. */
const clean = (url) =>
  String(url || "")
    .trim()
    .replace(/^stremio:\/\//i, "https://")
    .replace(/\/+$/, "")
    .replace(/\/(manifest|repo|plugins)\.json$/i, "");

const getJSON = async (url, ms = 15000) => {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "AutoCAT/1.0" }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/**
 * **Read a repository's `manifest.json`.** A Nuvio repository publishes an array; a few
 * publish `{ providers: [...] }` — both are accepted, and every file is resolved against the
 * base that answered, because `filename` is a path inside the repository.
 */
async function readManifest(url) {
  const bases = await repoBasesDeep(url);
  let lastError = "no manifest.json";
  for (const base of bases) {
    for (const candidate of [`${base}/manifest.json`, base]) {
      try {
        const data = await getJSON(candidate);
        // **Four shapes of the same list.** The published repositories use `scrapers` (Phisher's
        // Repo, Gowaru's — eighty providers between them), the newer ones an array, and a few wrap
        // it in `providers` or `plugins`. All four mean "the providers in this repository", and
        // reading only one of them is how a working repository answers "no providers".
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.scrapers)
            ? data.scrapers
            : Array.isArray(data?.providers)
              ? data.providers
              : Array.isArray(data?.plugins)
                ? data.plugins
                : null;
        if (!list) {
          lastError = "that file is not a Nuvio manifest (no provider list)";
          continue;
        }
        const plugins = list
          .map((p) => ({
            id: String(p?.id || p?.internalName || p?.filename || p?.name || "").trim(),
            name: String(p?.name || p?.id || "provider").slice(0, 80),
            filename: String(p?.filename || p?.url || "").trim(),
            version: String(p?.version || ""),
            description: String(p?.description || ""),
            author: String(p?.author || ""),
            supportedTypes: (Array.isArray(p?.supportedTypes) ? p.supportedTypes : ["movie", "tv"]).map((t) => String(t)),
            formats: (Array.isArray(p?.formats) ? p.formats : []).map((f) => String(f)),
            logo: String(p?.logo || ""),
            // A manifest that says `enabled: false` is a template or a switch the author
            // turned off on purpose; everything else arrives switched on, because a repo
            // that was just added is a repo somebody wants to use.
            enabled: p?.enabled === false ? false : true,
          }))
          .filter((p) => p.id && p.filename);
        if (!plugins.length) {
          lastError = "that manifest lists no providers";
          continue;
        }
        return { base, name: String(data?.name || ""), plugins };
      } catch (err) {
        lastError = String(err?.message || err);
      }
    }
  }
  throw new Error(lastError);
}

/** Every provider the app knows about, with the repository it came from. */
export function plugins({ enabledOnly = false } = {}) {
  const out = [];
  for (const repo of load().repos) {
    for (const plugin of repo.plugins || []) {
      if (enabledOnly && plugin.enabled === false) continue;
      // **`base` is where the manifest was actually read**, which is not always where the address
      // points: a GitHub page URL is resolved to raw files on `main`, `master`, `builds` or the
      // branch GitHub names. A provider's `filename` is a path inside *that* folder, so resolving
      // it against the address the user pasted is how every provider became an HTTP 404.
      out.push({ ...plugin, repo: repo.url, base: repo.base || repo.url, repoName: repo.name || repo.url, key: keyOf(repo.url, plugin) });
    }
  }
  return out;
}

/** What Settings draws: the repositories, their providers, and what the sandbox can offer. */
export async function state() {
  await warm();
  await seed();
  const { repos } = load();
  return {
    ok: true,
    repos: repos.map((repo) => ({ ...repo, key: repo.url })),
    count: plugins().length,
    on: plugins({ enabledOnly: true }).length,
    sandbox: ready(),
    timeout: TIMEOUT_MS,
    // Where a repository is expected to come from, said once so the pane does not have to.
    hint: "A Nuvio repository is a GitHub folder holding manifest.json and providers/. Paste its address (or the manifest.json itself).",
  };
}

/**
 * **Add a repository.** The manifest is read before anything is stored, so a typo cannot
 * leave a repository in the list that never answers — the same rule the plugin list uses.
 * A repository that is already there has its provider list refreshed instead of duplicated,
 * and a provider's on/off choice survives the refresh.
 */
export async function addRepo(url, { name = "" } = {}) {
  const clean_ = clean(url);
  if (!/^https?:\/\//i.test(clean_)) return { ok: false, message: "A repository address must start with http:// or https://" };
  let manifest;
  try {
    manifest = await readManifest(clean_);
  } catch (err) {
    return { ok: false, message: `That repository could not be read — ${err?.message || err}` };
  }
  const held = load();
  const existing = held.repos.find((r) => r.url === clean_);
  const before = new Map((existing?.plugins || []).map((p) => [p.id, p]));
  const plugins_ = manifest.plugins.map((p) => ({ ...p, enabled: before.has(p.id) ? before.get(p.id).enabled !== false : p.enabled !== false }));
  const entry = {
    url: clean_,
    name: String(name || manifest.name || clean_.replace(/^https?:\/\//i, "")).slice(0, 80),
    base: manifest.base,
    added: existing?.added || Date.now(),
    plugins: plugins_,
  };
  if (existing) held.repos[held.repos.indexOf(existing)] = entry;
  else held.repos.push(entry);
  persist();
  return { ok: true, repo: entry, message: `${plugins_.length} provider${plugins_.length === 1 ? "" : "s"}` };
}

export function removeRepo(url) {
  const held = load();
  const before = held.repos.length;
  held.repos = held.repos.filter((r) => r.url !== clean(url) && r.key !== url && r.url !== url);
  if (held.repos.length !== before) persist();
  return { ok: held.repos.length !== before };
}

/** Switch one provider on or off. Off, it is not asked for a title at all. */
export function setEnabled(key, on) {
  const held = load();
  for (const repo of held.repos) {
    for (const plugin of repo.plugins || []) {
      if (keyOf(repo.url, plugin) === key) {
        plugin.enabled = Boolean(on);
        persist();
        return { ok: true };
      }
    }
  }
  return { ok: false, message: "no such provider" };
}

/** Turn every provider of a repository on or off at once. */
export function setRepoEnabled(url, on) {
  const held = load();
  const repo = held.repos.find((r) => r.url === clean(url));
  if (!repo) return { ok: false, message: "no such repository" };
  for (const plugin of repo.plugins || []) plugin.enabled = Boolean(on);
  persist();
  return { ok: true };
}

/**
 * **A provider's source, read once and kept.** A repository is a fixed file: re-reading it for
 * every title would put a GitHub round trip in front of every play, and a provider that is
 * switched on for a series would pay it on every episode.
 */
async function sourceOf(plugin) {
  const base = String(plugin.base || plugin.repo || "").replace(/\/+$/, "");
  const url = /^https?:/i.test(plugin.filename) ? plugin.filename : `${base}/${String(plugin.filename).replace(/^\.?\//, "")}`;
  const hit = sources.get(url);
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return { url, source: hit.source };
  const res = await fetch(url, { headers: { accept: "text/javascript, application/javascript, */*", "user-agent": "AutoCAT/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`the provider file answered HTTP ${res.status}`);
  const source = await res.text();
  if (source.length > MAX_SOURCE_BYTES) throw new Error(`that provider file is ${Math.round(source.length / 1024)} KB — too large to run`);
  sources.set(url, { source, at: Date.now() });
  return { url, source };
}

/**
 * **Ask one provider for a title.**
 *
 * The provider is given exactly what Nuvio gives it — the TMDB id, the media type and, for an
 * episode, its numbers — and whatever it answers is normalised into this app's stream shape.
 * A provider that throws is reported by name, because "which provider failed" is the first
 * thing anyone reading the Sources drawer wants to know.
 */
export async function runProvider(plugin, { tmdbId, mediaType = "movie", season = 0, episode = 0 } = {}) {
  const label = `Nuvio · ${plugin.name}`;
  try {
    // **The sandbox has its modules before a provider runs.** Without this a provider that asks for
    // `crypto-js` before Settings had ever been opened was told the app does not carry it — a false
    // answer, produced by `warm()` not having run yet, and one that reads like a missing feature.
    await warm();
    const { source } = await sourceOf(plugin);
    const loaded = loadProvider(source, { name: `nuvio:${plugin.name}` });
    const fn = exportedFunction(loaded);
    if (!fn) {
      return { ok: false, label, message: "it does not export getStreams", streams: [], logs: loaded.logs };
    }
    const isSeries = mediaType === "tv" || mediaType === "series";
    const rows = await withDeadline(
      Promise.resolve().then(() =>
        fn(
          String(tmdbId || "").replace(/^tmdb:/, ""),
          isSeries ? "tv" : "movie",
          isSeries && season ? Number(season) : null,
          isSeries && episode ? Number(episode) : null,
        ),
      ),
      TIMEOUT_MS,
      "it did not answer in time",
    );
    const streams = (Array.isArray(rows) ? rows : rows ? [rows] : [])
      .map((row) => toStream(row, label))
      .filter(Boolean)
      // A provider that hands the same address out twice (a mirror list) is one row.
      .filter((row, i, all) => all.findIndex((o) => o.url === row.url) === i);
    return { ok: streams.length > 0, label, message: streams.length ? `${streams.length} streams` : "no streams", streams, logs: loaded.logs };
  } catch (err) {
    return { ok: false, label, message: String(err?.message || err), streams: [], logs: [] };
  }
}

/** Run `tasks` with at most `limit` in flight, keeping the order of the answers. */
async function pool(tasks, limit = CONCURRENCY) {
  const out = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * **Every switched-on provider, asked for one title.** This is what the player calls — see
 * `streamsFor` in `streams.mjs`, which merges these rows with the add-ons' own.
 *
 * The shape is the same one the add-on half produces (`streams` plus one line per source), so
 * the Sources drawer cannot tell the two apart, which is the point: it names who answered and
 * who did not, whether that is a URL or a provider.
 */
export async function providerStreams({ tmdbId, mediaType = "movie", season = 0, episode = 0, only = null } = {}) {
  const list = only ? plugins().filter((p) => p.key === only) : plugins({ enabledOnly: true });
  if (!tmdbId || !list.length) return { ok: false, streams: [], sources: [] };
  const results = await pool(list.map((plugin) => () => runProvider(plugin, { tmdbId, mediaType, season, episode })));
  const streams = results.flatMap((r) => r.streams);
  return {
    ok: streams.length > 0,
    streams,
    sources: results.map((r) => ({ name: r.label, ok: r.ok, message: r.message })),
    provider: results[0]?.label || "",
  };
}

/** Run one provider by key — the pane's own "Test" button, on a title you name. */
export async function test(key, { tmdbId, mediaType = "movie", season = 0, episode = 0 } = {}) {
  const plugin = plugins().find((p) => p.key === key);
  if (!plugin) return { ok: false, message: "no such provider" };
  const result = await runProvider(plugin, { tmdbId, mediaType, season, episode });
  return { ...result, key, name: plugin.name };
}

/** Forget the read provider files (a test after a repository was updated). */
export function refresh() {
  sources.clear();
  return { ok: true };
}
