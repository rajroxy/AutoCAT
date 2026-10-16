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
import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The first of these that exists, or the last one — which is then the hopeful default. */
function firstExisting(paths) {
  for (const candidate of paths) if (existsSync(candidate)) return candidate;
  return paths[paths.length - 1];
}

/**
 * **The server this app runs.** An installed app carries its own copy (electron-builder packs
 * `desktop/server/`); a checkout runs the repository's own `serve.mjs`, so editing the server
 * and pressing `npm start` still shows the change.
 */
function serverEntry() {
  if (!app.isPackaged) return path.join(__dirname, "..", "serve.mjs");
  return firstExisting([path.join(__dirname, "server", "serve.mjs"), path.join(__dirname, "..", "serve.mjs")]);
}

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

/** Where the packed interface and card art are, in an installed app. */
function packedPaths() {
  return {
    ui: firstExisting([path.join(__dirname, "ui"), path.join(__dirname, "desktop", "ui")]),
    covers: firstExisting([path.join(__dirname, "server", "covers"), path.join(__dirname, "covers")]),
  };
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

async function createWindow() {
  // A second window reuses the first server rather than leaving an orphan process behind.
  if (!server) {
    // An installed app: the interface and the artwork are inside the app, and everything the
    // app writes goes to the user's own data directory.
    if (app.isPackaged) {
      const packed = packedPaths();
      if (!process.env.AUTOCAT_UI_DIR) process.env.AUTOCAT_UI_DIR = packed.ui;
      if (!process.env.AUTOCAT_COVERS_DIR) process.env.AUTOCAT_COVERS_DIR = packed.covers;
      pointStateAtDataDir(app.getPath("userData"));
    }
    const { startServer } = await import(pathToFileURL(serverEntry()).href);
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

  // Any external link opens in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  console.log(`AutoCAT — window opened on ${home}`);
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
