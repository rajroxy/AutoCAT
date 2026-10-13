// AutoCAT preview server: the cover gallery AND the catalog addon on one origin.
//
//   /                       → covers/index.html (the gallery)
//   /covers/...             → cover assets (also served at /)
//   /collections.json       → every card + its catalogs (used by the desktop app)
//   /manifest.json          → Stremio/AutoCAT addon manifest
//   /catalog/{type}/{id}.json → live catalog rows (TMDB)
//   /addon-status.json      → addon diagnostics
//
// `startServer()` is exported so the Electron desktop app embeds the same
// server instead of reimplementing it. Running this file directly still serves
// the preview on PORT (default 4173).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleAddon } from "./addon/index.mjs";
import { installProcessGuards } from "./addon/guards.mjs";

const ROOT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const COVERS = resolve(ROOT_DIR, "covers");
const UI = resolve(ROOT_DIR, "desktop", "ui");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  // **The app's own typefaces** (Settings → Font). A `.woff2` served as
  // `application/octet-stream` is refused by the font loader — the file arrives, and
  // the face is still reported as failed, which is a font setting that looks broken
  // rather than one that is missing.
  // The browsing music is a file, so it needs an audio type.
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** Join a URL path onto a root, staying inside it; returns an existing file or null. */
async function safeFile(root, rel) {
  let filePath = join(root, normalize(decodeURIComponent(rel || "")).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, ""));
  if (!filePath.startsWith(root)) return null;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
    await stat(filePath);
  } catch {
    return null;
  }
  return filePath;
}

/**
 * Route a URL to a file:
 *   /            → the app UI (desktop/ui) — the same UI as the desktop app
 *   /app/...     → the app UI
 *   /gallery     → the cover gallery (covers/index.html)
 *   /covers/...  → cover assets (also the fallback)
 */
async function resolveFile(pathname) {
  if (pathname === "/app/") return safeFile(UI, "index.html");
  if (pathname === "/gallery" || pathname === "/gallery/") return safeFile(COVERS, "index.html");
  if (pathname.startsWith("/app/")) return safeFile(UI, pathname.slice(5));
  if (pathname.startsWith("/covers/")) return safeFile(COVERS, pathname.slice(8));
  return safeFile(COVERS, pathname);
}

function originOf(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
  // Behind the managed proxy TLS terminates upstream, so the forwarded proto can
  // read "http" even for a public https request. Android blocks cleartext HTTP,
  // so anything non-local must be advertised as https or AutoCAT cannot load it.
  const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : isLocal ? "http" : "https";
  return `${proto}://${host}`;
}

/**
 * Start the gallery + addon server. Returns the listening http.Server, so the
 * caller can read `server.address().port` (useful with port 0).
 */
export function startServer({ port = Number(process.env.PORT) || 4173, host = "0.0.0.0" } = {}) {
  // **Before anything can be scraped.** Reading a Custom Website means running that
  // page's own scripts in this process, and a promise one of them leaves rejected is
  // fatal to Node — the whole server, not just that site. The guard absorbs those (and
  // records them for /addon-status.json) so a bad page can never answer **502** for
  // everything else. See `addon/guards.mjs`.
  installProcessGuards();

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;

    // Addon routes first — they answer /manifest.json, /collections.json and /catalog/*.
    try {
      if (await handleAddon(req, res, pathname, originOf(req))) return;
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
      return;
    }

    // The app UI uses relative asset paths (./style.css, ./app.js) so it also
    // works when Electron loads it from file://. That requires a trailing-slash
    // base: at bare "/" the browser would resolve ./style.css to /style.css and
    // load an unstyled page with no JS. Redirect to /app/ first.
    if (pathname === "/" || pathname === "/index.html" || pathname === "/app") {
      res.writeHead(302, { location: "/app/" });
      res.end();
      return;
    }

    const filePath = await resolveFile(pathname);
    if (!filePath) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 — not found");
      return;
    }
    try {
      const body = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, {
        "content-type": TYPES[ext] || "application/octet-stream",
        // The app's own source changes with every edit, and `no-cache` only asks a
        // browser to *revalidate* — with no validator sent, a browser is free to
        // keep serving the copy it already has. That is how "the dropdowns aren't
        // styled" and "the old wording is still there" stayed true after the fix
        // shipped. Source is `no-store` now, so the next load is the next build;
        // artwork keeps a revalidating `no-cache`.
        "cache-control": [".html", ".css", ".js", ".mjs", ".json"].includes(ext) ? "no-store" : "no-cache",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 — not found");
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}

// Direct run (`node serve.mjs`) — the managed preview uses this.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then((server) => {
    const { port } = server.address();
    console.log(`AutoCAT gallery + catalog addon → http://0.0.0.0:${port}`);
  });
}
