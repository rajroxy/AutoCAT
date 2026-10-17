/**
 * **The sandbox a third-party stream provider runs in.**
 *
 * Two ecosystems publish a provider as a *file of JavaScript at a URL*:
 *
 *   Nuvio        `manifest.json` → `{ filename: "providers/<name>.js" }` → `getStreams(…)`
 *   CloudStream  `plugins.json`  → the entries whose `url` ends in `.js`
 *
 * Both are written to run somewhere else — Nuvio's on Hermes, CloudStream's on the JVM —
 * and both do the same thing in the end: fetch a few pages and return a list of playable
 * URLs. That is small enough to run here, which is what this module is for.
 *
 * ## What the sandbox honestly is
 *
 * A `node:vm` context with **no `require` of our own modules, no `process`, no `fs`, no
 * `net`** — a provider can fetch, parse and return, and cannot touch this machine's files
 * or settings. `require` exists but only as a **short list of named modules** (see
 * `REGISTRY`): a provider bundled for Nuvio keeps `require("cheerio-without-node-native")`
 * as an external call, and without that name resolved every such provider would fail at
 * its first line. Anything not on the list fails with a sentence naming it.
 *
 * `vm` is documented as unsuitable for running hostile code, and this is not claimed as a
 * security boundary: a provider you add is code you chose to run. It contains accidents
 * and misbehaviour, not an attacker — the same judgement as installing an add-on.
 *
 * ## What a provider may look like
 *
 * Nuvio's build step emits **CommonJS** (`module.exports = { getStreams }`), but a
 * hand-written provider is as likely to use `export function getStreams`. Both are
 * accepted: `toCommonJS` rewrites the handful of `export` shapes into an assignment
 * before the source is run, and `exportedFunction` finds the callable afterwards.
 */
import vm from "node:vm";
import { createRequire } from "node:module";

const hostRequire = createRequire(import.meta.url);

/** How long a provider's **synchronous** work may take before it is stopped. */
const SCRIPT_TIMEOUT_MS = 10000;
/** How many `console` lines are kept for the plugin tester. */
export const MAX_LOGS = 60;
/** A provider larger than this is not a provider. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

/**
 * **The modules a provider may `require` by name.**
 *
 * The names are the ones Nuvio providers are bundled against. `cheerio-without-node-native`
 * is the React Native fork of cheerio; the API this app hands back is plain `cheerio`, which
 * is the same `load()`/`$()` surface the fork copies — so a provider written for Nuvio's own
 * runtime parses its pages here unchanged. A name that is not installed at all is reported
 * by name rather than as a stack trace, because "this provider needs X" is the whole answer.
 */
const REGISTRY = {
  cheerio: () => import("cheerio"),
  "cheerio-without-node-native": () => import("cheerio"),
  buffer: () => ({ Buffer, atob, btoa }),
  url: () => ({ URL, URLSearchParams }),
  crypto: () => import("node:crypto"),
  util: () => import("node:util"),
  // **`crypto-js`, because providers really do use it.** Nothing exotic: three of the web
  // providers decrypt an API's payload with it (`CryptoJS.AES.decrypt`, `HmacSHA256`), and a
  // provider the sandbox cannot feed is a provider that answers *"this provider needs the module
  // crypto-js, which this app does not carry"* instead of a stream. It is a small pure-JS package
  // and it is the exact API those bundles were written against, so it is carried rather than
  // imitated — a shim that decrypts almost right is worse than an absent module.
  // **`crypto-js` is CommonJS**, so its ESM namespace keeps the real object on `default` and a
  // provider that writes `CryptoJS.enc.Base64` would meet `undefined` — which is exactly the
  // failure a first attempt at this produced. The interop object is what `require("crypto-js")`
  // returns, so that is what the shim hands over.
  "crypto-js": () => import("crypto-js").then((m) => m.default || m),
};

/** name → the module namespace, once `warm()` has resolved it. */
const modules = new Map();
/** Names that are not installed here, so a failure is reported once and not re-tried. */
const absent = new Set();
let warmed = null;

/**
 * Resolve every name in `REGISTRY` that this machine actually has.
 *
 * Called once, from the modules that need it. A package that is missing is remembered as
 * absent — a provider that needs it then fails with its name, which is a sentence a person
 * can act on, where `Cannot find module` from inside a bundle is not.
 */
export function warm() {
  if (warmed) return warmed;
  warmed = Promise.all(
    Object.entries(REGISTRY).map(async ([name, load]) => {
      try {
        modules.set(name, await load());
      } catch {
        absent.add(name);
      }
    }),
  ).then(() => undefined);
  return warmed;
}

/** What the sandbox can offer, for a settings pane that wants to say so. */
export const ready = () => ({ modules: [...modules.keys()], absent: [...absent] });

/** The `require` a provider sees: the registry, and a sentence for anything else. */
function requireShim(name) {
  const key = String(name || "").replace(/^node:/, "");
  if (modules.has(key)) return modules.get(key);
  if (modules.has(`node:${key}`)) return modules.get(`node:${key}`);
  throw new Error(`this provider needs the module "${name}", which this app does not carry`);
}

/**
 * **`export` → CommonJS.** The three shapes a hand-written provider uses, and nothing else:
 * a default export, named declarations, and a named list. Anything stranger is left alone —
 * a rewrite that guessed at more would break the CommonJS bundles that need no rewriting at
 * all, which is what most published providers are.
 */
export function toCommonJS(source) {
  const src = String(source || "");
  if (!/(^|[\s;}])export[\s{]/.test(src)) return src; // already CommonJS
  const names = [];
  let out = src
    // `export default async function getStreams(…)` → the function, exported by name.
    .replace(/\bexport\s+default\s+(async\s+)?function\s+([A-Za-z0-9_$]*)/g, (m, async, name) => {
      const fn = name || "defaultExport";
      names.push(fn);
      return `${async || ""}function ${fn}`;
    })
    // `export const x = …`, `export async function y(…)` → the declaration, minus `export`.
    .replace(/\bexport\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g, (m, kind, name) => {
      names.push(name);
      return `${kind} ${name}`;
    })
    // `export { a, b as c }` → a list appended at the end, where the names exist.
    .replace(/\bexport\s*\{([^}]*)\}\s*;?/g, (m, list) => {
      const pairs = list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [local, exported] = s.split(/\s+as\s+/).map((x) => String(x || "").trim());
          names.push(exported || local);
          return `${exported || local}: ${local}`;
        });
      return pairs.length ? `\nmodule.exports = Object.assign(module.exports, { ${pairs.join(", ")} });\n` : "";
    });
  const declared = names.filter((n) => !out.includes(`module.exports = Object.assign(module.exports, { ${n}:`));
  if (declared.length) out += `\n;module.exports = Object.assign(module.exports, { ${declared.map((n) => `${n}: ${n}`).join(", ")} });\n`;
  return out;
}

/**
 * Run a provider's source in the sandbox and hand back what it exported.
 *
 * `logs` is filled as the provider runs — its own `console.log` lines, kept for the plugin
 * tester, because a provider that answers nothing is otherwise a black box.
 */
export function loadProvider(source, { name = "provider", globals = {} } = {}) {
  const logs = [];
  const log = (level) => (...args) => {
    if (logs.length >= MAX_LOGS) return;
    logs.push(`${level}: ${args.map((a) => (typeof a === "string" ? a : safe(a))).join(" ")}`);
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: requireShim,
    console: { log: log("log"), warn: log("warn"), error: log("error"), info: log("info"), debug: log("debug") },
    fetch: (...args) => fetch(...args),
    Headers,
    Request,
    Response,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Buffer,
    atob,
    btoa,
    structuredClone,
    ...globals,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = undefined;
  vm.createContext(sandbox);
  new vm.Script(toCommonJS(source), { filename: `${name}.js` }).runInContext(sandbox, { timeout: SCRIPT_TIMEOUT_MS });
  const exported = sandbox.module.exports;
  return { exported, logs, sandbox, source };
}

const safe = (value) => {
  try {
    return JSON.stringify(value)?.slice(0, 400) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * **The function a provider offers.** Every name any ecosystem has used for it, in the order
 * they are tried — a provider that exports something else is reported as such rather than
 * being called and crashing on the first line.
 */
export function exportedFunction(loaded) {
  const out = loaded?.exported;
  const candidates = [out, out?.default, out?.getStreams, out?.default?.getStreams, loaded?.sandbox?.getStreams];
  return candidates.find((fn) => typeof fn === "function") || null;
}

/**
 * **Wait for a promise the sandbox cannot time out.** `vm`'s timeout covers synchronous work
 * only, so a provider that never answers its own `fetch` has to be given its own deadline
 * here — otherwise a dead host holds the Sources drawer open forever.
 */
export function withDeadline(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * **A stream row in this app's shape.** Nuvio publishes `{ name, title, url, quality, headers }`
 * and CloudStream's JS plugins publish something close enough to read with the same lines.
 *
 * `headers` matters: a host that serves only to a request carrying its own `Referer` is the
 * common case, and this app's own proxy adds exactly that when a stream carries `referer`.
 * So a `Referer` a provider set becomes the row's `referer`, and the player plays it through
 * the proxy without anyone having to know.
 */
export function toStream(row, label) {
  if (!row) return null;
  if (typeof row === "string") return row.startsWith("http") || row.startsWith("magnet:") ? { url: row, source: label } : null;
  const url = String(row.url || row.link || row.file || "").trim();
  if (!url) return null;
  const headers = row.headers && typeof row.headers === "object" ? row.headers : {};
  const referer = headers.Referer || headers.referer || row.referer || "";
  const quality = String(row.quality || row.resolution || "").trim();
  return {
    url,
    source: label,
    name: String(row.name || label).slice(0, 120),
    title: String(row.title || row.label || quality || "").slice(0, 200),
    quality,
    // Only a real header travels: an empty string would make the player proxy a stream that
    // needs no proxy at all.
    referer: String(referer || ""),
    headers,
    infoHash: String(row.infoHash || ""),
    // Nuvio and CloudStream both hand magnet links out occasionally; the player knows what
    // to do with one, and stating it here saves it from having to guess.
    torrent: Boolean(row.infoHash) || /^magnet:/i.test(url),
  };
}

export { hostRequire };
