// AutoCAT — Electron main process.
//
// Boots the same gallery + catalog server the preview uses, then opens a window on the shared
// web UI. From a checkout the server is `../serve.mjs` and nothing here has to think about it;
// **in an installed app** the server, the interface and the card art are all packed *inside*
// the app (see `scripts/desktop-server-folder.mjs` and `build.files` in package.json), so the
// three paths are handed over and the app's own state is moved to the user's data directory —
// program files are not writable.
//
// Requires Electron >= 28 (ESM entry point). Run with:  npm start
//
// **Pointing the installed app at a checkout.** `AUTOCAT_DEV_DIR=<checkout>` makes this app boot
// the checkout's server and read its interface and card art, while leaving everything that makes
// it the installed app alone (its own Electron, its own window, the user's data directory, the
// real sign-in origin) — so a change can be seen by pressing `Ctrl+R` instead of by packaging the
// app again. See `desktop/dev-paths.mjs` for the three cases.
import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } from "electron";
import { mkdirSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appPaths } from "./dev-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * **The server, the interface and the card art this launch reads.** An installed app carries its
 * own copies (electron-builder packs `desktop/server/`); a checkout runs the repository's own
 * `serve.mjs`, so editing the server and pressing `npm start` still shows the change; and
 * `AUTOCAT_DEV_DIR` hands an installed app a checkout's copies instead of its own.
 */
const PATHS = appPaths({
  isPackaged: app.isPackaged,
  appDir: __dirname,
  devDir: process.env.AUTOCAT_DEV_DIR,
});

/**
 * **Where the app remembers things.** In a checkout every state file is written beside its own
 * module, which is exactly what a person debugging expects. An installed app's program files
 * may be read-only (and on macOS they are), so `settings.json`, the watchlist, the pins, the
 * lineup and the caches are all pointed at the app's data directory — the addon modules have
 * honoured these variables all along, and now one place names all of them.
 */
function pointStateAtDataDir(dir) {
  mkdirSync(dir, { recursive: true });
  const files = {
    AUTOCAT_SETTINGS_FILE: "settings.json",
    AUTOCAT_WATCHLIST_FILE: "watchlist.json",
    AUTOCAT_PLAYERS_FILE: "players.json",
    AUTOCAT_PREFS_FILE: "user-preferences.json",
    AUTOCAT_DNS_FILE: "dns-config.json",
    AUTOCAT_CUSTOM_FILE: "customrows.json",
    AUTOCAT_CUSTOM_SITES_FILE: "custom-sites.json",
    AUTOCAT_REPOSITORIES_FILE: "repositories.json",
    AUTOCAT_LIVE_FILE: "live-cache.json",
    AUTOCAT_PARTY_FILE: "party.json",
    AUTOCAT_ACCOUNT_FILE: "account.json",
    AUTOCAT_LINEUP_FILE: "lineup.json",
  };
  for (const [name, file] of Object.entries(files)) {
    if (!process.env[name]) process.env[name] = path.join(dir, file);
  }
}


// Chromium refuses to start with its sandbox when Electron runs as root (common
// in containers and some Linux setups) and exits before any window appears.
// Only that case drops the sandbox — a normal user keeps it.
if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) {
  app.commandLine.appendSwitch("no-sandbox");
}

let server;
let mainWindow;
let retried = false;

/**
 * **The embedded server's port is fixed, because a sign-in callback has to be
 * registered in advance.**
 *
 * The window used to start the server on port **0** — an OS-picked free port, a new one
 * every launch. That is exactly right for the app's own pages and impossible for OAuth:
 * Google and GitHub want one exact redirect URI, and a URI whose port changes on the next
 * launch can never be registered. So the port is pinned (4173, the same default `npm run
 * preview` uses, and `AUTOCAT_DESKTOP_PORT` moves it), and `AUTOCAT_PUBLIC_URL` is set to that
 * origin so the callback this server sends is the same string Settings shows.
 *
 * If something else already holds the port the app still opens — on an OS-picked one — and
 * Settings → Sign in shows the callback in use, so it stays registerable for that session.
 */
const DESKTOP_PORT = Number(process.env.AUTOCAT_DESKTOP_PORT) || 4173;

/**
 * **The clipboard, from the process that owns it.** `desktop/preload.cjs` asks for this, and the
 * page's own Paste button asks the preload — so a pasted add-on / repository address works the same
 * on Windows, macOS and Linux, whatever the renderer's clipboard permissions are.
 */
ipcMain.handle("autocat:clipboard", () => {
  try {
    return clipboard.readText() || "";
  } catch {
    return "";
  }
});

async function createWindow() {
  // A second window reuses the first server rather than leaving an orphan process behind.
  if (!server) {
    if (PATHS.dev) {
      // **The checkout the app was pointed at.** The interface and the card art come from there,
      // and so does the server below; the app's own state stays wherever this launch keeps it
      // (the data directory when installed, beside the modules in a checkout).
      if (PATHS.ui) process.env.AUTOCAT_UI_DIR = PATHS.ui;
      if (PATHS.covers) process.env.AUTOCAT_COVERS_DIR = PATHS.covers;
      console.log(`AutoCAT — running the checkout at ${PATHS.root}\n          interface: ${PATHS.ui}\n          server:    ${PATHS.server}`);
    } else if (app.isPackaged) {
      // An installed app: the interface and the artwork are inside the app, and everything the
      // app writes goes to the user's own data directory.
      if (PATHS.ui && !process.env.AUTOCAT_UI_DIR) process.env.AUTOCAT_UI_DIR = PATHS.ui;
      if (PATHS.covers && !process.env.AUTOCAT_COVERS_DIR) process.env.AUTOCAT_COVERS_DIR = PATHS.covers;
    }
    if (app.isPackaged) pointStateAtDataDir(app.getPath("userData"));
    const { startServer } = await import(pathToFileURL(PATHS.server).href);
    try {
      server = await startServer({ port: DESKTOP_PORT, host: "127.0.0.1" });
    } catch (err) {
      console.warn(`AutoCAT — port ${DESKTOP_PORT} was not free (${err?.code || err}); using an OS-picked one.\n` +
        `          The sign-in callback in Settings → Sign in will show the port in use.`);
      server = await startServer({ port: 0, host: "127.0.0.1" });
    }
  }
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const home = `${origin}/app/`;
  // **The origin a provider is told to come back to.** Set here rather than left to the
  // request, so the callback is this app's own origin even if the page was reached some
  // other way — see `redirectUri` in `addon/auth.mjs`.
  process.env.AUTOCAT_PUBLIC_URL = origin;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // The window is painted before the UI arrives, so it wears the app's own ink.
    backgroundColor: "#0B0B0B",
    title: "AutoCAT",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // **The microphone is the only thing this shell grants, and only to itself.** The Ask box's
  // voice button records a clip and has the app's own AI provider read it (`/ai/transcribe`),
  // so `media` has to be allowed — Chromium asks the shell first, and a refused request is a
  // mic button that does nothing. Everything else (notifications, geolocation, camera, MIDI,
  // the lot) stays refused: nothing in this app asks for it.
  try {
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      const from = String(contents?.getURL?.() || "");
      callback(permission === "media" && from.startsWith(origin));
    });
  } catch (err) {
    console.warn(`AutoCAT — could not register the microphone permission handler: ${err?.message || err}`);
  }

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // The window loads the UI **from the embedded server** — the very origin that
  // answers /manifest.json, /catalog/*.json, /api/source (the add-on, plugin and
  // repository lookup) and the cover images. Over http every one of those is a
  // same-origin request, so Stremio add-ons, CloudStream repos, the
  // catalogs and the artwork behave in the desktop app exactly as they do in the
  // browser preview. Loaded from file:// they would all be cross-origin.
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!retried) {
      retried = true;
      mainWindow.loadURL(home).catch(() => {});
      return;
    }
    dialog.showErrorBox(
      "AutoCAT could not open",
      `The app window failed to load (${code} ${description}).\n\n${url}\n\n` +
        `The embedded server is on ${origin}.\n` +
        `Run "npm run start:web" and open ${home} in a browser to see the same app.`,
    );
  });

  try {
    await mainWindow.loadURL(home);
  } catch {
    /* did-fail-load has already reported it */
  }

  if (process.env.AUTOCAT_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });

  // **A checkout reloads itself.** With `AUTOCAT_DEV_DIR` set, the window reloads a moment after
  // any file under the checkout's interface changes, so saving a stylesheet or a page is enough —
  // no `Ctrl+R`, no rebuild. Server modules are deliberately not watched: node caches the import
  // graph, so a new `serve.mjs` needs the app restarted and reloading the window would only look
  // like a fix that did nothing.
  if (PATHS.dev && PATHS.ui) watchCheckout(PATHS.ui);

  // Any external link opens in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  console.log(`AutoCAT — window opened on ${home}`);
}

/**
 * Reload the window when the checkout it was pointed at changes.
 *
 * One-shot edits arrive in bursts (a formatter, an editor's temp file), so the reload waits for a
 * quiet moment, and a watcher that cannot start on this platform or filesystem is not an error:
 * the app simply keeps `Ctrl+R` as the way to see a change.
 */
function watchCheckout(dir) {
  let timer = null;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log("[dev] the checkout changed — reloading the window");
        mainWindow.webContents.reload();
      }
    }, 250);
  };
  try {
    watch(dir, { recursive: true }, reload);
    console.log(`AutoCAT — watching ${dir} (save a file and the window reloads)`);
  } catch (err) {
    console.warn(`AutoCAT — could not watch ${dir} (${err?.message || err}); press Ctrl+R to see a change.`);
  }
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (server) {
    server.close();
    server = undefined;
  }
  if (process.platform !== "darwin") app.quit();
});
