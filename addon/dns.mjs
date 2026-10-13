/**
 * DNS: which resolver the whole app asks.
 *
 * The system resolver is whatever the machine, the router and the ISP agree on — which is
 * sometimes an ISP that lies about a domain, filters it, or answers from a cache that has
 * gone stale. This lets the app ask a resolver of the user's choosing instead, and it
 * applies **everywhere**: metadata, catalogs, add-ons, subtitles, debrid, the scraper and
 * the stream proxy all fetch through `addon/net.mjs`, which reads this file on each call.
 * A resolver is not a VPN and does not hide anything: it only changes how a *domain* turns
 * into an address.
 *
 * The setting lives in `dns-config.json` (git-ignored, created at runtime) so it survives
 * a restart, and `activeDnsServers()` is the single question the rest of the app asks.
 */
import fs from "node:fs";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopedFile } from "./scope.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_FILE = process.env.AUTOCAT_DNS_FILE || path.join(__dirname, "dns-config.json");

/* The resolver is chosen per profile like every other setting, so one profile turning
   on AdGuard does not silently change where the other one's requests resolve. */
const file = () => scopedFile(BASE_FILE, "dns-config");

/** The resolvers Settings offers. `servers` empty means "type your own". */
export const DNS_PRESETS = [
  // **None is a choice, not an empty box.** With no preset for "I do not want an override"
  // the only way back to the machine's resolver was to turn the switch off and leave the
  // addresses sitting there — which read as still configured. Picking None clears them.
  { name: "None", servers: [] },
  { name: "Google", servers: ["8.8.8.8", "8.8.4.4"] },
  { name: "Cloudflare", servers: ["1.1.1.1", "1.0.0.1"] },
  { name: "AdGuard", servers: ["94.140.14.14", "94.140.15.15"] },
  { name: "Quad9", servers: ["9.9.9.9", "149.112.112.112"] },
  { name: "OpenDNS", servers: ["208.67.222.222", "208.67.220.220"] },
  { name: "Custom", servers: [] },
];

const DEFAULTS = {
  enabled: false,
  provider: "cloudflare",
  primary: "1.1.1.1",
  secondary: "1.0.0.1",
};

/** An IPv4 or IPv6 literal — the only thing a resolver address may be. */
export const isIp = (value) => {
  const v = String(value || "").trim();
  if (!v) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split(".").every((p) => Number(p) <= 255);
  // A generous IPv6 check: hex groups and `::`, which is what a user would paste.
  return /^[0-9a-f:]{2,45}$/i.test(v) && v.includes(":");
};

/**
 * A stored resolver address: a plain IP, or an `IP:port` for a resolver on a non-standard
 * port — a local Pi-hole or `dnsmasq` listens on 5353 far more often than a user expects.
 * The Settings pane still takes a bare IP (that is what a person knows); this is what the
 * file is allowed to hold, and what `setServers` accepts.
 */
export const isResolverAddress = (value) => {
  const v = String(value || "").trim();
  if (!v) return false;
  if (isIp(v)) return true;
  const m = /^(.+):(\d{1,5})$/.exec(v);
  return Boolean(m && isIp(m[1]) && Number(m[2]) >= 1 && Number(m[2]) <= 65535);
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
  cache.provider = DNS_PRESETS.some((p) => p.name.toLowerCase() === String(cache.provider).toLowerCase())
    ? String(cache.provider)
    : DEFAULTS.provider;
  cache.enabled = cache.enabled === true;
  return cache;
}

function persist() {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(load(), null, 2) + "\n");
  } catch {
    /* read-only fs — the in-memory copy still applies for this run */
  }
}

export const getDns = () => load();

/** The preset a provider name refers to (case-insensitive). */
export const dnsPreset = (name) => DNS_PRESETS.find((p) => p.name.toLowerCase() === String(name || "").toLowerCase()) || null;

/**
 * Save a change and return the new config.
 *
 * A preset carries its own two addresses; `Custom` keeps whatever is typed. The addresses
 * are validated on the way in, so a settings file cannot hold a nonsense resolver that
 * then makes every request in the app fail.
 */
export function updateDns(patch = {}) {
  const next = load();
  if (patch.provider !== undefined) {
    const preset = dnsPreset(patch.provider);
    if (preset) {
      next.provider = preset.name;
      if (preset.servers.length) {
        next.primary = preset.servers[0];
        next.secondary = preset.servers[1] || "";
      }
    }
  }
  if (patch.primary !== undefined && isResolverAddress(patch.primary)) next.primary = String(patch.primary).trim();
  if (patch.secondary !== undefined) {
    const v = String(patch.secondary).trim();
    if (!v || isResolverAddress(v)) next.secondary = v;
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  cache = next;
  persist();
  return next;
}

/** The two addresses in force, or nothing when the override is off. */
export function activeDnsServers() {
  const d = load();
  if (!d.enabled) return [];
  return [d.primary, d.secondary].filter(isResolverAddress);
}

/** A resolver pointed at the configured servers, for `lookup`/`resolve` callers. */
export function resolver(servers = activeDnsServers(), timeout = 5000) {
  const r = new dns.promises.Resolver({ timeout, tries: 2 });
  if (servers.length) r.setServers(servers);
  return r;
}

/**
 * Resolve a host with the configured resolver, falling back to the system one.
 *
 * Returns `{ ip, family, via }` where `via` says which resolver answered — the point of
 * the Settings button is to show the two side by side.
 */
export async function resolveHost(host, servers = activeDnsServers()) {
  const name = String(host || "").trim().replace(/^https?:\/\//, "").split("/")[0];
  if (!name) return { ok: false, message: "Enter a domain to resolve." };
  if (activeDnsServers().length && servers.length) {
    try {
      const [ip] = await resolver(servers).resolve4(name);
      if (ip) return { ok: true, ip, family: ip.includes(":") ? 6 : 4, via: servers.join(", ") };
    } catch (err) {
      // Fall through to the system resolver rather than failing the whole call: an
      // unreachable resolver is a fact worth reporting, not a reason to answer nothing.
      const sys = await systemResolve(name);
      return sys.ok
        ? { ...sys, note: `the configured resolver did not answer (${err?.code || err?.message}), so the system one did` }
        : { ok: false, message: `the configured resolver did not answer (${err?.code || err?.message})` };
    }
  }
  return systemResolve(name);
}

/** The system resolver's answer, for comparison. */
export async function systemResolve(host) {
  const name = String(host || "").trim().replace(/^https?:\/\//, "").split("/")[0];
  try {
    const r = await dns.promises.lookup(name, { all: false });
    return { ok: true, ip: r.address, family: r.family, via: "system" };
  } catch (err) {
    return { ok: false, message: `the system resolver could not resolve it (${err?.code || err?.message})` };
  }
}

/** The public view: what the pane shows, never a secret (there is none here). */
export function publicDns() {
  const d = load();
  const servers = activeDnsServers();
  return {
    enabled: d.enabled,
    provider: d.provider,
    primary: d.primary,
    secondary: d.secondary,
    servers,
    presets: DNS_PRESETS.map((p) => ({ name: p.name, servers: p.servers })),
  };
}

/**
 * What a test of `google.com` finds, both ways.
 *
 * The point is the pair: a resolver that answers with a different address than the system
 * one is doing what it was asked, and one that answers with nothing is not.
 */
export async function testDns(host = "google.com") {
  const servers = activeDnsServers();
  const system = await systemResolve(host);
  if (!load().enabled || !servers.length) {
    return { ok: system.ok, host, system, configured: null, message: system.ok ? "The override is off — the system resolver answered." : system.message };
  }
  const configured = await resolveHost(host, servers);
  const differs = system.ok && configured.ok && system.ip !== configured.ip;
  return {
    ok: configured.ok,
    host,
    system,
    configured: { ...configured, via: servers.join(", ") },
    message: configured.ok
      ? `Resolved via ${servers.join(", ")} → ${configured.ip}${differs ? ` (the system resolver said ${system.ip})` : system.ok ? " (same as the system resolver)" : ""}.`
      : configured.message,
  };
}

/** What the override is actually applied to — shown so the answer is not a guess. */
export const dnsScope = () => ({
  nodeFetch: "every server-side request the app makes, through addon/net.mjs",
  metadata: "TMDB, TVDB, MDBList, Trakt, Simkl, the anime and drama trackers, BetterPosters",
  ai: "OpenRouter, Groq, Cerebras, Google AI Studio",
  scraper: ["static (tier 1)", "js-sandbox (tier 2, its script fetches)", "browser (tier 3, host mapping)"],
  other: ["Stremio add-ons", "custom websites", "subtitles", "debrid APIs", "the stream proxy"],
  player: "the embedded player keeps the system resolver (mpv/ExoPlayer are separate processes) — document, not override",
});
