/**
 * **CloudStream repositories and their extensions, on the server.**
 *
 * A CloudStream repository is the same shape of thing a Nuvio repository is — a folder of
 * files — but its files say something different:
 *
 *   repo.json      `{ name, description, manifestVersion, pluginLists: [ "…/plugins.json" ] }`
 *   plugins.json   an *array* of extensions: `{ internalName, name, url, version, authors,
 *                  language, tvTypes, iconUrl, apiVersion, … }`
 *   <url>          the extension itself — for almost every repository a **compiled `.cs3`**
 *                  (a dex/JAR), built from Kotlin by the CloudStream plugin template
 *
 * ## What can run here, and what cannot — said plainly
 *
 * A `.cs3` is **compiled code for Android's own runtime**. Running it needs a JVM with a dex
 * loader and CloudStream's own API surface around it; a JavaScript runtime cannot execute it
 * and no amount of effort here changes that. Extensions are therefore *listed, kept and
 * switched on/off* — the repository is read exactly as CloudStream reads it, so you can see
 * what a repository carries — and the ones that are **plain JavaScript** are run, because a
 * `.js` extension is a file of code like any other (see `pluginvm.mjs`).
 *
 * Nothing pretends otherwise: an extension that cannot run is labelled with the reason in the
 * pane, instead of appearing beside the working ones and quietly answering nothing.
 *
 * ## Why the pane exists at all
 *
 * Because a CloudStream repository is where these extensions are *published*, and the app's
 * own answer to "where does my content come from" should be able to read one: what it is
 * called, what it carries, which of them are on, and what each one is (compiled or script).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoBasesDeep } from "./sources.mjs";
import { exportedFunction, loadProvider, MAX_SOURCE_BYTES, ready, toStream, warm, withDeadline } from "./pluginvm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.AUTOCAT_CLOUDSTREAM_FILE || path.join(__dirname, "cloudstream.json");
const TIMEOUT_MS = Number(process.env.AUTOCAT_CLOUDSTREAM_TIMEOUT_MS) || 45000;
const SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

let store = null;
const sources = new Map();

const load = () => {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = { repos: Array.isArray(parsed?.repos) ? parsed.repos : [] };
  } catch {
    store = { repos: [] };
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

const clean = (url) =>
  String(url || "")
    .trim()
    .replace(/^cloudstream:\/\//i, "https://")
    .replace(/\/+$/, "")
    .replace(/\/(repo|plugins|manifest)\.json$/i, "");

const keyOf = (repoUrl, id) => `${repoUrl}::${id}`;

/**
 * **What an extension's `url` actually is.** `script` is a provider this app can run; `compiled`
 * is a dex/JAR only the CloudStream app can; anything else is named as what it is, so a pane can
 * say "unknown file" rather than guessing.
 */
export function fileKind(url) {
  const file = String(url || "").split("?")[0].toLowerCase();
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "script";
  if (file.endsWith(".cs3") || file.endsWith(".jar") || file.endsWith(".dex")) return "compiled";
  return "other";
}

const KIND_NOTE = {
  script: "a JavaScript extension — run here like any provider",
  compiled: "compiled for CloudStream (dex) — only the CloudStream app can run it",
  other: "not a file this app can run",
};

const getJSON = async (url, ms = 15000) => {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "AutoCAT/1.0" }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/**
 * **Read a repository the way CloudStream does**: `repo.json`, then every `plugins.json` it
 * names. Both layouts in the wild are accepted (`pluginLists` as strings or as `{ url }`), and
 * a relative list address is resolved against the base that answered.
 */
async function readRepo(url) {
  let lastError = "no repo.json";
  for (const base of await repoBasesDeep(url)) {
    let repo;
    try {
      repo = await getJSON(`${base}/repo.json`);
    } catch (err) {
      lastError = String(err?.message || err);
      continue;
    }
    const lists = Array.isArray(repo?.pluginLists) ? repo.pluginLists : Array.isArray(repo?.plugins) ? repo.plugins : [];
    const urls = lists.map((l) => (typeof l === "string" ? l : l?.url || l?.list || "")).filter(Boolean);
    if (!urls.length) {
      lastError = "that repo.json names no plugin lists";
      continue;
    }
    const extensions = [];
    for (const listUrl of urls.slice(0, 12)) {
      const abs = /^https?:/i.test(listUrl) ? listUrl : `${base}/${String(listUrl).replace(/^\.?\//, "")}`;
      try {
        const data = await getJSON(abs);
        const items = Array.isArray(data) ? data : Array.isArray(data?.plugins) ? data.plugins : [];
        for (const p of items) {
          const id = String(p?.internalName || p?.name || p?.url || "").trim();
          if (!p?.url || !id) continue;
          extensions.push({
            id,
            key: "",
            name: String(p?.name || id).slice(0, 80),
            description: String(p?.description || "").slice(0, 300),
            // A relative extension address is resolved against the list that named it.
            url: /^https?:/i.test(String(p.url)) ? String(p.url) : `${base}/${String(p.url).replace(/^\.?\//, "")}`,
            version: String(p?.version || ""),
            language: String(p?.language || ""),
            authors: (Array.isArray(p?.authors) ? p.authors : []).map((a) => String(a)),
            tvTypes: (Array.isArray(p?.tvTypes) ? p.tvTypes : []).map((t) => String(t)),
            icon: String(p?.iconUrl || ""),
            apiVersion: Number(p?.apiVersion) || 0,
            kind: fileKind(p?.url),
          });
        }
      } catch {
        /* one dead list must not sink the repository */
      }
    }
    if (!extensions.length) {
      lastError = "its plugin lists named no extensions";
      continue;
    }
    return { base, name: String(repo?.name || ""), description: String(repo?.description || ""), extensions };
  }
  throw new Error(lastError);
}

/** Every extension the app knows, with the repository it came from. */
export function extensions({ enabledOnly = false, runnable = false } = {}) {
  const out = [];
  for (const repo of load().repos) {
    for (const ext of repo.extensions || []) {
      if (enabledOnly && ext.enabled === false) continue;
      if (runnable && ext.kind !== "script") continue;
      out.push({ ...ext, key: keyOf(repo.url, ext.id), repo: repo.url, repoName: repo.name || repo.url });
    }
  }
  return out;
}

export async function state() {
  await warm();
  const { repos } = load();
  const all = extensions();
  return {
    ok: true,
    repos: repos.map((repo) => ({ ...repo, key: repo.url, extensions: (repo.extensions || []).map((e) => ({ ...e, key: keyOf(repo.url, e.id) })) })),
    count: all.length,
    on: all.filter((e) => e.enabled !== false).length,
    runnable: all.filter((e) => e.kind === "script").length,
    sandbox: ready(),
    kinds: KIND_NOTE,
    note: "CloudStream extensions are compiled for Android (dex). This app reads the repository, keeps the extensions and runs the JavaScript ones; a compiled extension needs the CloudStream app itself.",
  };
}

/** Add a repository, reading it before anything is stored. */
export async function addRepo(url, { name = "" } = {}) {
  const base = clean(url);
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: "A repository address must start with http:// or https://" };
  let repo;
  try {
    repo = await readRepo(base);
  } catch (err) {
    return { ok: false, message: `That repository could not be read — ${err?.message || err}` };
  }
  const held = load();
  const existing = held.repos.find((r) => r.url === base);
  const before = new Map((existing?.extensions || []).map((e) => [e.id, e]));
  const list = repo.extensions.map((e) => ({ ...e, enabled: before.has(e.id) ? before.get(e.id).enabled !== false : true }));
  const entry = {
    url: base,
    name: String(name || repo.name || base.replace(/^https?:\/\//i, "")).slice(0, 80),
    description: repo.description,
    base: repo.base,
    added: existing?.added || Date.now(),
    extensions: list,
  };
  if (existing) held.repos[held.repos.indexOf(existing)] = entry;
  else held.repos.push(entry);
  persist();
  const runnable = list.filter((e) => e.kind === "script").length;
  return {
    ok: true,
    repo: entry,
    message: `${list.length} extension${list.length === 1 ? "" : "s"}${runnable ? ` · ${runnable} JavaScript` : ""}`,
  };
}

export function removeRepo(url) {
  const held = load();
  const before = held.repos.length;
  held.repos = held.repos.filter((r) => r.url !== clean(url) && r.key !== url && r.url !== url);
  if (held.repos.length !== before) persist();
  return { ok: held.repos.length !== before };
}

export function setEnabled(key, on) {
  const held = load();
  for (const repo of held.repos) {
    for (const ext of repo.extensions || []) {
      if (keyOf(repo.url, ext.id) === key) {
        ext.enabled = Boolean(on);
        persist();
        return { ok: true };
      }
    }
  }
  return { ok: false, message: "no such extension" };
}

export function setRepoEnabled(url, on) {
  const held = load();
  const repo = held.repos.find((r) => r.url === clean(url));
  if (!repo) return { ok: false, message: "no such repository" };
  for (const ext of repo.extensions || []) ext.enabled = Boolean(on);
  persist();
  return { ok: true };
}

const sourceOf = async (ext) => {
  const hit = sources.get(ext.url);
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS) return hit.source;
  const res = await fetch(ext.url, { headers: { accept: "text/javascript, application/javascript, */*", "user-agent": "AutoCAT/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`the extension file answered HTTP ${res.status}`);
  const source = await res.text();
  if (source.length > MAX_SOURCE_BYTES) throw new Error(`that file is ${Math.round(source.length / 1024)} KB — too large to run`);
  sources.set(ext.url, { source, at: Date.now() });
  return source;
};

/**
 * Run one extension.
 *
 * Only a `.js` extension is ever asked, and it is asked the only way a stream provider can be
 * asked here: `getStreams(tmdbId, type, season, episode)` — the same call a Nuvio provider
 * answers. A compiled extension is refused with the reason, not an exception.
 */
export async function runExtension(ext, { tmdbId, mediaType = "movie", season = 0, episode = 0 } = {}) {
  const label = `CloudStream · ${ext.name}`;
  if (ext.kind !== "script") return { ok: false, label, message: KIND_NOTE[ext.kind] || KIND_NOTE.other, streams: [], logs: [] };
  try {
    const source = await sourceOf(ext);
    const loaded = loadProvider(source, { name: `cloudstream:${ext.name}` });
    const fn = exportedFunction(loaded);
    if (!fn) return { ok: false, label, message: "it does not export a function this app can call", streams: [], logs: loaded.logs };
    const isSeries = mediaType === "tv" || mediaType === "series";
    const rows = await withDeadline(
      Promise.resolve().then(() =>
        fn(String(tmdbId || "").replace(/^tmdb:/, ""), isSeries ? "tv" : "movie", isSeries && season ? Number(season) : null, isSeries && episode ? Number(episode) : null),
      ),
      TIMEOUT_MS,
      "it did not answer in time",
    );
    const streams = (Array.isArray(rows) ? rows : rows ? [rows] : []).map((row) => toStream(row, label)).filter(Boolean);
    return { ok: streams.length > 0, label, message: streams.length ? `${streams.length} streams` : "no streams", streams, logs: loaded.logs };
  } catch (err) {
    return { ok: false, label, message: String(err?.message || err), streams: [], logs: [] };
  }
}

/** Every switched-on JavaScript extension, asked for one title. */
export async function extensionStreams({ tmdbId, mediaType = "movie", season = 0, episode = 0 } = {}) {
  const list = extensions({ enabledOnly: true, runnable: true });
  if (!tmdbId || !list.length) return { ok: false, streams: [], sources: [] };
  const results = [];
  for (const ext of list) results.push(await runExtension(ext, { tmdbId, mediaType, season, episode }));
  const streams = results.flatMap((r) => r.streams);
  return { ok: streams.length > 0, streams, sources: results.map((r) => ({ name: r.label, ok: r.ok, message: r.message })) };
}

export async function test(key, { tmdbId, mediaType = "movie", season = 0, episode = 0 } = {}) {
  const ext = extensions().find((e) => e.key === key);
  if (!ext) return { ok: false, message: "no such extension" };
  const result = await runExtension(ext, { tmdbId, mediaType, season, episode });
  return { ...result, key, name: ext.name };
}

export function refresh() {
  sources.clear();
  return { ok: true };
}
