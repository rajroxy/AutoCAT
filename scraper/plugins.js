/**
 * Plugins: a site the tiers cannot read, taught by hand.
 *
 * The three tiers are general — they read markup, run scripts, drive a browser. Some
 * sites defeat all three by design: the URL is built by an obfuscated player, the page
 * needs a signed request, the stream arrives over a websocket. The answer for those is
 * not a fourth general tier; it is a rule for that one site, and this is where rules are
 * kept.
 *
 * A plugin is a **JavaScript file at a URL the user pastes**. It is downloaded, kept, and
 * run only when the tiers have all come back empty *and* the page belongs to the plugin's
 * domain.
 *
 * ## What "sandboxed" honestly means here
 *
 * The plugin runs in a `node:vm` context with no `require`, no `process`, no `fs` — it
 * cannot touch the app's files, its settings or its keys, and it gets only the helpers
 * below. That is a containment boundary for accidents and for a plugin that misbehaves,
 * **not a security boundary** against a plugin that is actively hostile: `vm` is
 * documented as unsuitable for running untrusted code, and a plugin you paste is code
 * you chose to run. Paste plugins you trust, from people you trust — the same judgement
 * as installing an add-on.
 *
 * ## The contract
 *
 * A plugin exports one function and returns stream rows (or promises of them):
 *
 *   module.exports = async function extract(url, helpers) {
 *     const html = await helpers.fetchHTML(url);   // tier 1, with the session's cookies
 *     return [{ url: "https://…/video.m3u8", quality: "1080p", title: "Episode 1" }];
 *   };
 *
 * `helpers` is small on purpose: `fetchHTML`, `renderJS`, `browser` (the same three tiers,
 * so a plugin can build on them rather than reimplement them) and `found` (the regex
 * finder). Everything else the plugin wants, it can fetch itself.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { fetchStaticHTML } from "./tier1.js";
import { renderJS } from "./tier2.js";
import { fetchWithStealth } from "./tier3.js";
import { findStreamsInHTML } from "./finder.js";
import { hostOf, domainOf } from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.AUTOCAT_PLUGINS_FILE || path.join(__dirname, "plugins.json");
const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_SOURCE_BYTES = 512 * 1024;

let store = null;
/** name -> the evaluated function, so a page read twice does not parse its plugin twice. */
const compiled = new Map();

const load = () => {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = Array.isArray(parsed?.plugins) ? parsed : { plugins: [] };
  } catch {
    store = { plugins: [] };
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

/** A name for a plugin that was not given one: the file, then the host. */
const nameFor = (url) => {
  const file = String(url).split("?")[0].split("/").filter(Boolean).pop() || "plugin";
  return file.replace(/\.js$/i, "") || domainOf(url) || "plugin";
};

/**
 * Paste a plugin: download it, check it is a plugin at all, and keep it.
 *
 * The check is real — the source is evaluated once, in the sandbox, with no URL to work
 * on, purely to see that it produced a function. A file that does not is not stored, so a
 * typo in a URL cannot leave a plugin that fails silently on every page later.
 *
 * @param {{ url: string, name?: string, domains?: string[] }} input
 */
export async function addPlugin({ url, name = "", domains = [] } = {}) {
  const src = String(url || "").trim();
  if (!/^https?:\/\//i.test(src)) return { ok: false, message: "A plugin URL must start with http:// or https://" };

  let source;
  try {
    const res = await fetchWithTimeout(src);
    if (!res.ok) return { ok: false, message: `The plugin could not be downloaded (HTTP ${res.status}).` };
    source = await res.text();
  } catch (err) {
    return { ok: false, message: `The plugin could not be downloaded — ${err?.message || err}` };
  }
  if (source.length > MAX_SOURCE_BYTES) return { ok: false, message: `That file is ${Math.round(source.length / 1024)} KB — too large to be a plugin.` };

  const name2 = String(name || nameFor(src)).slice(0, 60);
  let fn;
  try {
    fn = evaluate(source, name2);
  } catch (err) {
    return { ok: false, message: `That file is not a plugin — ${err?.message || err}` };
  }
  if (typeof fn !== "function") return { ok: false, message: "That file does not export a function, so there is nothing to call." };

  const s = load();
  const cleaned = (Array.isArray(domains) ? domains : String(domains).split(","))
    .map((d) => String(d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  const entry = { name: name2, url: src, domains: cleaned.length ? cleaned : [domainOf(src)].filter(Boolean), enabled: true, source, added: Date.now() };
  const at = s.plugins.findIndex((p) => p.name === name2 || p.url === src);
  if (at >= 0) s.plugins[at] = { ...s.plugins[at], ...entry };
  else s.plugins.push(entry);
  persist();
  compiled.delete(name2);
  return { ok: true, plugin: publicPlugin(entry) };
}

async function fetchWithTimeout(url) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: control.signal, headers: { accept: "text/javascript, application/javascript, text/plain, */*" } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a plugin's source in a `vm` context and return the function it exports.
 *
 * `module.exports`, `exports.extract` and a bare `extract` are all accepted, because a
 * plugin author writes whichever of those their habit suggests and all three mean the
 * same thing.
 */
function evaluate(source, name) {
  const quiet = () => {};
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: { log: quiet, warn: quiet, error: quiet, info: quiet, debug: quiet },
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    fetch: (...args) => fetch(...args),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(String(source), { filename: `plugin:${name}` }).runInContext(sandbox, { timeout: 5000 });
  const out = sandbox.module.exports;
  if (typeof out === "function") return out;
  if (out && typeof out === "object") {
    const fn = out.default || out.extract || out.getStreams;
    if (typeof fn === "function") return fn;
  }
  return typeof sandbox.extract === "function" ? sandbox.extract : null;
}

const publicPlugin = ({ source, ...rest }) => ({ ...rest, size: source ? source.length : 0 });

/** Every plugin, without its source — what Settings lists. */
export function listPlugins() {
  return load().plugins.map(publicPlugin);
}

/** Forget a plugin by name or URL. */
export function removePlugin(nameOrUrl) {
  const s = load();
  const before = s.plugins.length;
  s.plugins = s.plugins.filter((p) => p.name !== nameOrUrl && p.url !== nameOrUrl);
  if (s.plugins.length !== before) {
    compiled.delete(String(nameOrUrl));
    persist();
  }
  return before !== s.plugins.length;
}

/**
 * The plugin that claims this page, if any.
 *
 * A plugin's `domains` are matched against both the exact host and the site, so a plugin
 * written for `example.com` also gets `www.example.com`.
 */
export function pluginFor(url) {
  const host = hostOf(url);
  const site = domainOf(url);
  if (!host) return null;
  return (
    load().plugins.find((p) => {
      if (p.enabled === false) return false;
      const domains = (p.domains || []).map((d) => String(d).toLowerCase());
      if (!domains.length) return true; // no claim made — it is there for pages nothing else reads
      return domains.some((d) => d === host || d === site || host.endsWith(`.${d}`));
    }) || null
  );
}

/** Normalise whatever a plugin returned into the app's stream shape. */
function shape(rows, name) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list
    .map((r) => (typeof r === "string" ? { url: r } : r || {}))
    .filter((r) => r.url)
    .map((r) => ({
      url: String(r.url),
      quality: String(r.quality || "unknown"),
      title: String(r.title || "Stream"),
      source: `plugin:${name}`,
    }));
}

/**
 * Ask the plugin for a page's streams.
 *
 * A plugin that throws is reported by name and nothing else happens — one broken rule
 * must not take the extraction down with it, and "which plugin failed" is the first thing
 * anyone debugging it wants to know.
 */
export async function runPlugin(url, plugin = pluginFor(url)) {
  if (!plugin) return { ok: false, reason: "no-plugin", streams: [] };
  let fn = compiled.get(plugin.name);
  if (!fn) {
    try {
      fn = evaluate(plugin.source, plugin.name);
    } catch (err) {
      return { ok: false, reason: "broken", plugin: plugin.name, message: String(err?.message || err), streams: [] };
    }
    if (typeof fn !== "function") return { ok: false, reason: "broken", plugin: plugin.name, message: "it does not export a function", streams: [] };
    compiled.set(plugin.name, fn);
  }

  const helpers = { fetchHTML: fetchStaticHTML, renderJS, browser: fetchWithStealth, found: findStreamsInHTML };
  try {
    // The promise is awaited outside the vm's timeout, so a slow page is the plugin's
    // business; the timeout covers the plugin's own synchronous work.
    const rows = await fn(url, helpers);
    const streams = shape(rows, plugin.name);
    return { ok: streams.length > 0, reason: streams.length ? "" : "empty", plugin: plugin.name, streams };
  } catch (err) {
    return { ok: false, reason: "failed", plugin: plugin.name, message: String(err?.message || err), streams: [] };
  }
}
