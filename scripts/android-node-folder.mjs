/**
 * Builds the Node.js project the Android TV app carries inside itself.
 *
 * **Why the app needs this.** The APK is the whole app: no PC, no LAN server, no
 * localhost someone has to start. Every card, cover and row is produced by the
 * catalog server — `serve.mjs` and the `addon/*.mjs` modules beside it — and that
 * server is JavaScript. So it is shipped *inside* the APK and started by the Node
 * runtime the app carries (Capacitor's Node.js plugin, which embeds Node.js for
 * Mobile Apps; this is the same way Stremio's Android app runs on device). The
 * WebView then talks to it on `http://127.0.0.1:4173` — the address `ui/config.js`
 * falls back to in a packaged build. Nothing is asked of the user and nothing runs
 * outside the box.
 *
 * What lands in `desktop/ui/nodejs/` (the plugin's `nodeDir`, under the webDir, so
 * `cap sync` copies it into the APK's assets):
 *
 *   package.json   the project's name, `type: module` and its `main`
 *   index.cjs      started by the runtime: it starts the catalog server
 *   serve.mjs      the server itself
 *   addon/, scripts/, scraper/   every module the server imports
 *   covers/        the card art the server hands out (`/covers/…`)
 *
 * **The state files are deliberately left out.** Everything under `addon/` and
 * `scripts/` that ends in `.json` (settings, watchlist, the lineup, the caches) is the
 * *machine's* state, not the app's — copying one into an APK would ship somebody's
 * profile, and a fresh install has to start empty anyway. Only `.mjs` is walked in, and
 * the server creates each state file on its first write — so the app's TMDB key, its
 * profile and its lists live on the device from the first run.
 *
 * Usage: `node scripts/android-node-folder.mjs` (or `npm run android:node` from
 * `desktop/`, which also runs before `cap sync`).
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reachableModules } from "./lib/reach.mjs";
import { vendorModules } from "./lib/vendor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COVERS = join(ROOT, "covers");
const DEST = join(ROOT, "desktop", "ui", "nodejs");

/**
 * The port the on-device server listens on. **Pinned, not chosen**, for the same
 * reason the desktop app's is (see `main.js`): the WebView has to know the address
 * before the server has said anything, and a port picked at random would need a
 * channel to be told through. 4173 is what `npm run preview` and the Electron window
 * already use, so one address holds everywhere.
 */
const PORT = 4173;

/** The entry the runtime runs. CommonJS, so `require("bridge")` works. */
const INDEX = `"use strict";

// **The catalog server, started inside the app.** This file is the project's own
// "main": Capacitor's Node.js runtime starts it on a background thread, it puts the server on
// 127.0.0.1, and the WebView reads every card and row from there. No part of the app
// needs a machine outside the device.

const PORT = ${PORT};

/** The runtime's bridge, when there is one (the APK); a plain Node run has none. */
function bridge() {
  try {
    return require("bridge");
  } catch {
    return null;
  }
}

const app = bridge()?.app || null;
// **A writable home for anything that must survive an app update.** The plugin's own
// warning is that the project folder may be replaced when the app updates; the server's
// own state files live beside its modules (which is fine, and where they usually are),
// and this directory is reported so a reader can see where the device would put them.
try {
  if (app?.datadir) console.log("[autocat] device data dir:", app.datadir());
} catch {
  /* the bridge is a nice-to-have here, never a requirement */
}

import("./serve.mjs")
  .then(({ startServer }) => startServer({ port: PORT, host: "127.0.0.1" }))
  .then((server) => {
    console.log("[autocat] catalog server listening on http://127.0.0.1:" + server.address().port);
  })
  .catch((err) => {
    console.error("[autocat] the catalog server did not start:", err);
  });
`;

// **`type: module`, because the server and `scraper/*.js` are ESM** — the repo's own
// package.json declares it, and without it Node parses `scraper/index.js` as CommonJS and
// reparses (a warning on every run, and a hard failure where the syntax happens not to be
// recoverable). The entry is `index.cjs`, which is CommonJS whatever this field says, so the
// runtime's `require("bridge")` keeps working.
const PACKAGE = JSON.stringify(
  {
    name: "autocat-nodejs",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "index.cjs",
  },
  null,
  2,
) + "\n";

const size = async (path) => (await stat(path)).size;

await rm(DEST, { recursive: true, force: true });
await mkdir(join(DEST, "addon"), { recursive: true });
await mkdir(join(DEST, "covers"), { recursive: true });

const modules = await reachableModules({ root: ROOT, entry: join(ROOT, "serve.mjs") });
for (const rel of modules) {
  const to = join(DEST, rel);
  await mkdir(dirname(to), { recursive: true });
  await cp(join(ROOT, rel), to);
}

// The card art. The server publishes `/covers/<movies|shows>/<key>.png`, the covers the
// app's own card pages wear, so the APK has to carry them: there is nowhere else to get
// them from once nothing outside the device is running.
let coverBytes = 0;
for (const row of ["movies", "shows"]) {
  await mkdir(join(DEST, "covers", row), { recursive: true });
  const names = (await readdir(join(COVERS, row))).filter((name) => name.endsWith(".png"));
  for (const name of names) {
    await cp(join(COVERS, row, name), join(DEST, "covers", row, name));
    coverBytes += await size(join(COVERS, row, name));
  }
}

/**
 * **And the packages its modules need.** The import walk above copies the app's own modules; these
 * are the npm ones, which from a checkout resolve out of the repository and inside an APK have
 * nothing above them to resolve from. `torrent-stream` is the pure-JavaScript torrent engine —
 * WebTorrent's `node-datachannel` is native and cannot be built on a device, which is why a magnet
 * never played on a TV — and `cheerio` is what a provider bundled for Nuvio expects under the name
 * `cheerio-without-node-native` (see `addon/pluginvm.mjs`).
 *
 * `webtorrent` is deliberately **not** vendored: it would be 34 MB of a dependency that cannot load
 * here, and `addon/torrent.mjs` falls back cleanly when it is absent.
 */
const vendored = await vendorModules({
  into: DEST,
  packages: ["torrent-stream", "cheerio"],
  from: [join(ROOT, "node_modules"), join(ROOT, "desktop", "node_modules")],
});

await writeFile(join(DEST, "index.cjs"), INDEX, "utf8");
await writeFile(join(DEST, "package.json"), PACKAGE, "utf8");

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

console.log(
  `Android node project → desktop/ui/nodejs\n` +
    `  ${modules.length} module(s) (${modules.filter((m) => m.startsWith("scripts/")).length} from scripts/), covers ${mb(coverBytes)}\n` +
    `  ${vendored.copied.length} npm package(s) vendored, ${mb(vendored.bytes)} (${vendored.copied
      .slice(0, 4)
      .map((p) => p.name)
      .join(", ")}${vendored.copied.length > 4 ? ", …" : ""})\n` +
    `  port ${PORT} (the address ui/config.js falls back to in a packaged build)`,
);
// A package that is not installed here cannot be copied, and the failure it would cause on the
// device is a provider that answers nothing — so it is said out loud, with the command that fixes it.
if (vendored.missing.length) {
  console.warn(
    `  · not installed here, so NOT in the APK: ${vendored.missing.join(", ")} — run "npm install" in the repository root (and in desktop/) before syncing`,
  );
}
