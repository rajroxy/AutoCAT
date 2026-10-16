/**
 * Source inspection — read what an add-on, plugin or repository actually offers.
 *
 * This runs **on the server**, not in the page. That is the fix for "addons,
 * plugins and repos not working": a browser cannot read `manifest.json` from an
 * arbitrary third-party host unless that host sends permissive CORS headers (most
 * do not), and a CloudStream repo lives on `raw.githubusercontent.com`, not at
 * the page's origin. Fetching here has no such restriction.
 *
 *   add-on        → GET <base>/manifest.json            → name + catalogs
 *   plugin/repo   → GET <base>/repo.json → pluginLists  → GET each plugins.json
 *
 * A GitHub URL is translated to its raw files (trying `main`, then `master`).
 */

const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i;

/**
 * **The branches these repositories publish on.** A GitHub URL is translated to its raw files,
 * and translating it to `main` alone made two whole ecosystems fail: Nuvio's own repository
 * publishes on `template`, and a CloudStream repository publishes `repo.json` on `builds`. Those
 * are guesses too — see `repoBasesDeep` for the one that is not.
 */
export const GITHUB_BRANCHES = ["main", "master", "builds"];

/** The `owner/repo` a GitHub URL names, or `null`. */
export function githubRepo(url) {
  const gh = String(url || "").match(GITHUB);
  return gh ? { owner: gh[1], repo: gh[2] } : null;
}

/**
 * **Where a repository's files really are.**
 *
 * The guessed branches first, because almost every repository is on one of them and they cost a
 * request each only when they miss — and then, if they all missed, **the branch GitHub itself
 * names**: one API call for the repository's `default_branch`. That is the difference between
 * "paste this repository's address" working and a 404 on a repository that is fine, for a
 * repository whose default branch is not one anybody would guess.
 */
export async function repoBasesDeep(url) {
  const bases = repoBases(url);
  const gh = githubRepo(url);
  if (!gh) return bases;
  for (const branch of GITHUB_BRANCHES) {
    const base = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${branch}`;
    if (!bases.includes(base)) bases.push(base);
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": ADDON_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const branch = String(data?.default_branch || "").trim();
      const base = branch ? `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${branch}` : "";
      if (base && !bases.includes(base)) bases.push(base);
    }
  } catch {
    /* the branches above are what is left */
  }
  return bases;
}

/** Where the files of a repo may live — a GitHub URL maps to raw.githubusercontent. */
export function repoBases(url) {
  const clean = String(url || "")
    .replace(/^stremio:\/\//i, "https://")
    .replace(/\/+$/, "")
    .replace(/\/(repo|plugins|manifest)\.json$/i, "");
  const gh = clean.match(GITHUB);
  const out = [];
  if (gh) {
    for (const branch of ["main", "master"]) out.push(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${branch}`);
  }
  out.push(clean);
  return [...new Set(out.filter(Boolean))];
}

// **5xx is the add-on's own host, and it is usually momentary.** A Cloudflare-fronted
// add-on answers 503 while its origin restarts and answers 200 a second later — which is
// the difference between "your add-on works" and a row that reads "HTTP 503" every time
// the app starts. Only 5xx is retried: a 404 is an answer, and retrying it would double
// every legitimate miss.
const TRANSIENT = new Set([502, 503, 504]);
// One User-Agent for every outbound add-on call, this file and `streams.mjs` alike. A
// request with no agent at all is the shape a host's bot rules are most likely to refuse.
const ADDON_UA = "AutoCAT/1.0";

async function getJSON(url, timeoutMs = 12000) {
  const send = () =>
    fetch(url, {
      headers: { accept: "application/json", "user-agent": ADDON_UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res = await send();
  if (!res.ok && TRANSIENT.has(res.status)) {
    // Let the origin come back before asking again.
    await new Promise((r) => setTimeout(r, 700));
    res = await send();
  }
  if (!res.ok) {
    throw new Error(
      res.status >= 500 ? `HTTP ${res.status} — the add-on's own server is failing` : `HTTP ${res.status}`,
    );
  }
  return res.json();
}

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/** Every plugin name a CloudStream-style repository publishes. */
async function cloudStreamRepo(url) {
  for (const base of repoBases(url)) {
    let repo;
    try {
      repo = await getJSON(`${base}/repo.json`);
    } catch {
      continue;
    }
    const lists = Array.isArray(repo?.pluginLists)
      ? repo.pluginLists
      : Array.isArray(repo?.plugins)
        ? repo.plugins
        : [];
    const urls = lists.map((l) => (typeof l === "string" ? l : l?.url || l?.list || "")).filter(Boolean);

    const providers = [];
    for (const listUrl of urls.slice(0, 5)) {
      try {
        const abs = /^https?:/i.test(listUrl) ? listUrl : `${base}/${String(listUrl).replace(/^\.?\//, "")}`;
        const data = await getJSON(abs);
        const items = Array.isArray(data) ? data : Array.isArray(data?.plugins) ? data.plugins : [];
        for (const p of items) {
          if (p?.name) providers.push(p.name);
          else if (typeof p === "string") providers.push(p);
        }
      } catch {
        /* one dead list must not sink the repository */
      }
    }
    return { name: repo?.name || null, description: repo?.description || "", providers: uniq(providers) };
  }
  throw new Error("no repo.json");
}

/**
 * Read a `manifest.json` and report what it offers.
 *
 * Two different things publish a `manifest.json`, and until this read them apart a
 * AutoCAT plugin came back as an add-on with **0 catalogs**:
 *
 *   Stremio add-on  `{ name, resources: ["catalog", "stream", …], catalogs: [ … ] }`
 *   AutoCAT plugin    `{ name, scrapers: [ { name, filename, formats, … } ] }`
 *
 * A AutoCAT plugin manifest has **no** `catalogs` and **no** `resources` at all — its
 * providers are the entries in `scrapers`, which is why every plugin read as empty.
 * Both shapes are returned here and the caller decides which one it is.
 */
async function addonManifest(url) {
  const clean = String(url || "").replace(/^stremio:\/\//i, "https://").replace(/\/+$/, "");
  // **Where a manifest can live.** One guess made a real add-on look unreachable: the
  // box took a website address, appended `/manifest.json`, and the add-on's own path
  // is a different one — so a working URL answered "not reachable". Every path a
  // Stremio add-on is published at is tried now, plus the site root of a deep link,
  // and the error the caller sees is the status of the last one rather than a blank
  // failure.
  const candidates = [];
  const add = (u) => { if (u && !candidates.includes(u)) candidates.push(u); };
  if (/\.json(\?|#|$)/i.test(clean)) {
    add(clean);
  } else {
    add(`${clean}/manifest.json`);
    add(`${clean}/.well-known/stremio/manifest.json`);
    try {
      const u = new URL(clean);
      const root = `${u.origin}${u.pathname.replace(/\/[^/]*$/, "")}`.replace(/\/+$/, "");
      if (root && root !== clean) add(`${root}/manifest.json`);
    } catch {
      /* not a URL we can take apart — the two paths above are what is left */
    }
    // The bare address last: a host can serve a manifest at its own root.
    add(clean);
  }
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const manifest = await getJSON(candidate);
      // A catalog is not required to carry a `name` — plenty of add-ons publish
      // `{ id, type }` only, and reading `name` alone left those add-ons looking
      // like they had no providers at all.
      const catalogs = uniq((manifest.catalogs || []).map((c) => c.name || c.id || c.type));
      // A AutoCAT plugin's providers. `name` is the label AutoCAT shows; `id` is the
      // fallback for a scraper that did not name itself.
      const scrapers = uniq((manifest.scrapers || []).map((s) => s?.name || s?.id));
      return {
        name: manifest.name || null,
        description: manifest.description || "",
        providers: catalogs.length ? catalogs : scrapers,
        scrapers,
        // What the add-on actually serves: `catalog`, `meta`, `stream`, `subtitles`
        // — a string or an object with a `name`, per the manifest spec.
        resources: uniq(
          (manifest.resources || [])
            .map((r) => (typeof r === "string" ? r : r?.name))
            .filter(Boolean),
        ),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  // The status **and** the address that produced it, so a failure names what was
  // tried instead of leaving the reader guessing which file was missing.
  throw new Error(lastErr ? `${lastErr.message} (${candidates[candidates.length - 1]})` : "not reachable");
}

const ADDON_KINDS = new Set(["stremio", "autocat"]);

/**
 * Inspect any source. Never throws — a failure is returned as `ok: false` with a
 * plain message, so the UI never shows a bare 404 for something that simply is
 * not an add-on.
 */
export async function inspectSource(type, url) {
  if (!url) return { ok: false, kind: type, message: "no url" };
  try {
    if (ADDON_KINDS.has(type)) {
      const { name, providers, resources, scrapers } = await addonManifest(url);
      // A Stremio add-on that happens to publish `scrapers` is really a plugin.
      if (scrapers.length) {
        return { ok: true, kind: "plugin", name, providers, scrapers, message: `${scrapers.length} scrapers` };
      }
      // **What it serves, counted.** A catalog-only line ("0 catalogs") could not
      // tell a stream-only add-on from a broken one, so the resources it declares
      // are counted alongside the catalogs it names.
      const supports = [
        resources.includes("stream") ? "streams" : "",
        resources.includes("meta") ? "metadata" : "",
        resources.includes("subtitles") ? "subtitles" : "",
      ].filter(Boolean);
      const message = `${providers.length} catalog${providers.length === 1 ? "" : "s"}${supports.length ? ` · ${supports.join(", ")}` : ""}`;
      return { ok: true, kind: "addon", name, providers, resources, supports, message };
    }
    // A AutoCAT plugin publishes `scrapers` in its own `manifest.json`. That is the
    // modern layout and it is tried first; the older CloudStream-style `repo.json`
    // is kept as the fallback, so both kinds of URL the app has ever offered work.
    if (type === "autocat-plugin") {
      try {
        const { name, providers, resources, scrapers } = await addonManifest(url);
        if (scrapers.length) {
          return { ok: true, kind: "plugin", name, providers, scrapers, message: `${scrapers.length} scrapers` };
        }
        // No scrapers but it did answer as a manifest: report what it serves rather
        // than pretending it is a repository.
        if (resources.length || providers.length) {
          return { ok: true, kind: "addon", name, providers, resources, message: `${providers.length} catalogs` };
        }
      } catch {
        /* fall through to the repo layout */
      }
    }
    const { name, providers, description } = await cloudStreamRepo(url);
    return { ok: true, kind: "repo", name, description, providers, scrapers: providers, message: `${providers.length} scrapers` };
  } catch (err) {
    return {
      ok: false,
      kind: type,
      message: ADDON_KINDS.has(type) ? `not reachable — ${err.message}` : "no repo.json found — stored for the native app",
    };
  }
}
