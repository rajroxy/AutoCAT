/**
 * **Which copy of the app runs, and where it reads from.**
 *
 * An installed app carries its own server, interface and card art (see
 * `scripts/desktop-server-folder.mjs` and `build.files` in `desktop/package.json`), and a
 * checkout reads the repository's own files. Both cases are decided in one place so a
 * third case can exist: **the installed app pointed at a checkout**.
 *
 * That third case is what `AUTOCAT_DEV_DIR` is for, and it is what makes fixing the app
 * bearable — the deb, the AppImage, the dmg and the exe all run *their own* bundled copy,
 * so a change to a stylesheet, a page or a server module could only ever be seen by
 * packaging the app again. With the variable set, the installed app keeps everything that
 * makes it the installed app (its own Electron, its own window, the user's data directory,
 * the real sign-in origin) but boots the **server** and reads the **interface and the card
 * art** from the directory named:
 *
 * ```sh
 * AUTOCAT_DEV_DIR=$HOME/Nuvio-collection autocat
 * ```
 *
 * Edit a file in the checkout, press `Ctrl+R` in the window, and the change is there. A
 * change to a **server** module (`serve.mjs`, `addon/*`) is the one thing a reload cannot
 * pick up — node caches the import graph — so the app is restarted for those.
 *
 * Nothing here is guessed: each path is the one the same layout uses when it is packaged,
 * and a path the directory does not have falls back to the app's own, with a line on the
 * console saying so. A nonsense `AUTOCAT_DEV_DIR` therefore cannot leave you with a window
 * that will not open — it leaves you with the app you had.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** The first of these that exists, or the last one — which is then the hopeful default. */
export function firstExisting(paths) {
  for (const candidate of paths) if (existsSync(candidate)) return candidate;
  return paths[paths.length - 1];
}

/**
 * The server, the interface and the card art this launch should use, plus whether they come
 * from a checkout (`dev`), which is what turns the reload watcher on.
 *
 * @param {{ isPackaged: boolean, appDir: string, devDir?: string }} opts
 *   `appDir` is the directory `main.js` lives in: the app's own root when packaged
 *   (`…/resources/app`), `desktop/` in a checkout.
 */
export function appPaths({ isPackaged, appDir, devDir = "" }) {
  const wanted = String(devDir || "").trim();
  if (wanted) {
    const dir = path.resolve(wanted);
    const ui = firstExisting([path.join(dir, "desktop", "ui"), path.join(dir, "server", "ui")]);
    const server = firstExisting([path.join(dir, "serve.mjs"), path.join(dir, "desktop", "server", "serve.mjs")]);
    if (existsSync(ui) && existsSync(server)) {
      return {
        dev: true,
        root: dir,
        server,
        ui,
        covers: firstExisting([path.join(dir, "covers"), path.join(dir, "desktop", "server", "covers")]),
      };
    }
    console.warn(
      `AutoCAT — AUTOCAT_DEV_DIR is set to ${dir} but that directory has no serve.mjs / desktop/ui,\n` +
        `          so this launch uses the app's own copy.`,
    );
  }

  if (isPackaged) {
    return {
      dev: false,
      root: appDir,
      server: firstExisting([path.join(appDir, "server", "serve.mjs"), path.join(appDir, "..", "serve.mjs")]),
      ui: firstExisting([path.join(appDir, "ui"), path.join(appDir, "desktop", "ui")]),
      covers: firstExisting([path.join(appDir, "server", "covers"), path.join(appDir, "covers")]),
    };
  }

  // A checkout: the repository's own `serve.mjs`, and no interface or art paths at all —
  // the server's defaults already point at `desktop/ui` and `covers`, so a checkout keeps
  // behaving exactly as it did before this module existed.
  const root = path.join(appDir, "..");
  return { dev: false, root, server: firstExisting([path.join(root, "serve.mjs")]), ui: null, covers: null };
}
