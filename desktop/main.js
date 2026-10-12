// AutoCAT — Electron main process.
//
// Boots the same gallery + catalog server the preview uses (imported from
// ../serve.mjs), then opens a window on the shared web UI. Because the UI is
// plain web code, the identical folder can be wrapped by Capacitor for an
// Android TV build later — see README.md.
//
// Requires Electron >= 28 (ESM entry point). Run with:  npm start
import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../serve.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * preview` uses, and `NUVIO_DESKTOP_PORT` moves it), and `NUVIO_PUBLIC_URL` is set to that
 * origin so the callback this server sends is the same string Settings shows.
 *
 * If something else already holds the port the app still opens — on an OS-picked one — and
 * Settings → Sign in shows the callback in use, so it stays registerable for that session.
 */
const DESKTOP_PORT = Number(process.env.NUVIO_DESKTOP_PORT) || 4173;

async function createWindow() {
  // A second window reuses the first server rather than leaving an orphan process behind.
  if (!server) {
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
  process.env.NUVIO_PUBLIC_URL = origin;

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

  if (process.env.NUVIO_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });

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
