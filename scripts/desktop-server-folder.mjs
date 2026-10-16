/**
 * Builds the server the **packaged desktop app** carries.
 *
 * The Electron app has always booted the catalog server out of this repository
 * (`import { startServer } from "../serve.mjs"` in `desktop/main.js`). That works from a
 * checkout and cannot work from an installer: an installed app has `desktop/main.js` and a
 * `package.json` inside its own bundle and no repository above it. So `desktop/server/` is
 * built — the same import graph `serve.mjs` reaches, plus the card art it hands out — and
 * electron-builder packs that folder into the app (`build.files` in `desktop/package.json`).
 * `main.js` prefers it when it is there and falls back to the repository when it is not, so a
 * checkout keeps running exactly as before.
 *
 * The app's **state never lands in there**: the bundle is inside `app.asar`, which is
 * read-only (`settings.json`, the watchlist, the lineup and the caches are all written beside
 * their modules by default). `main.js` therefore points every state file at the app's own data
 * directory through the `AUTOCAT_*_FILE` variables the addon modules already honour.
 *
 * Usage: `node scripts/desktop-server-folder.mjs` (or `npm run desktop:server` from desktop/,
 * which every packaging script runs first).
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reachableModules } from "./lib/reach.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COVERS = join(ROOT, "covers");
const DEST = join(ROOT, "desktop", "server");

const modules = await reachableModules({ root: ROOT, entry: join(ROOT, "serve.mjs") });

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });

for (const rel of modules) {
  const to = join(DEST, rel);
  await mkdir(dirname(to), { recursive: true });
  await cp(join(ROOT, rel), to);
}

// The card art the server publishes at `/covers/…`. The packaged app has nowhere else to
// read it from, exactly as the APK does not.
let coverBytes = 0;
for (const row of ["movies", "shows"]) {
  await mkdir(join(DEST, "covers", row), { recursive: true });
  const names = (await readdir(join(COVERS, row))).filter((name) => name.endsWith(".png"));
  for (const name of names) {
    await cp(join(COVERS, row, name), join(DEST, "covers", row, name));
    coverBytes += (await stat(join(COVERS, row, name))).size;
  }
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

console.log(
  `Packaged desktop server → desktop/server\n` +
    `  ${modules.length} module(s) (${modules.filter((m) => m.startsWith("scripts/")).length} from scripts/, ` +
    `${modules.filter((m) => m.startsWith("scraper/")).length} from scraper/), covers ${mb(coverBytes)}\n` +
    `  state files are pointed at the app's data directory by main.js, never written in here`,
);
