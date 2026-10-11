// Launches the Electron desktop app. This is what `npm start` runs, from the
// repo root (`node scripts/start-desktop.mjs`) or from `desktop/`
// (`node ../scripts/start-desktop.mjs`).
//
// Electron is a package plus a ~100MB binary that its postinstall fetches, so
// there are two ways a fresh clone ends up without it:
//   1. the desktop dependencies were never installed at all, or
//   2. npm >= 11.16/12 blocked the postinstall because `electron` is not in the
//      package's `allowScripts` list (npm warns "1 package had install scripts
//      blocked"), which leaves the package present but the binary missing.
// Either way `electron .` dies with "Electron failed to install correctly".
// This wrapper fixes both: it installs the dependencies, and if the binary is
// still missing it runs Electron's own installer (`node install.js`) directly,
// which is exactly what the blocked postinstall would have done. So `npm start`
// always ends in the app, never in an error or a server url.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");
const ELECTRON = join(DESKTOP, "node_modules", "electron");
const CLI = join(ELECTRON, "cli.js");
const INSTALLER = join(ELECTRON, "install.js");

const installOnly = process.argv.includes("--install-only");

// We are starting the real app, so we do need the binary: any inherited opt-out
// must not reach the install steps.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_SKIP_BINARY_DOWNLOAD;

const npm = (args) =>
  spawnSync("npm", args, {
    cwd: DESKTOP,
    stdio: "inherit",
    env: childEnv,
    shell: process.platform === "win32",
  });

/**
 * Electron is usable only once its own installer has unzipped the binary and
 * written `path.txt`. Checking `path.txt` alone is not enough — it can point at
 * a binary that is not there — and that state is indistinguishable from a
 * successful install until `electron` throws.
 */
function electronReady() {
  try {
    const binary = readFileSync(join(ELECTRON, "path.txt"), "utf8").trim();
    return Boolean(binary) && existsSync(join(ELECTRON, "dist", binary));
  } catch {
    return false;
  }
}

if (!electronReady()) {
  console.log(
    "AutoCAT — installing the desktop app's dependencies.\n" +
      "This downloads Electron (about 100MB) the first time only…",
  );
  const install = npm(["install", "--no-audit", "--no-fund"]);
  if (install.status !== 0) {
    console.error(
      "\nThe install did not finish. Run it by hand to see the full output:\n" +
        "  cd desktop && npm install\n",
    );
    process.exit(install.status ?? 1);
  }
}

// Electron's postinstall is nothing but `node install.js`, so when npm skipped
// it we can run that file ourselves — no npm flag, no version-specific command,
// and it is idempotent (it exits at once if the binary is already in place).
if (!electronReady() && existsSync(INSTALLER)) {
  console.log("Electron's binary is still missing, so fetching it directly…");
  const fetched = spawnSync(process.execPath, [INSTALLER], {
    cwd: ELECTRON,
    stdio: "inherit",
    env: childEnv,
  });
  if (fetched.status !== 0) {
    console.error("\nElectron's own installer did not finish — see the output above.\n");
    process.exit(fetched.status ?? 1);
  }
}

if (installOnly) {
  if (!electronReady()) {
    console.error("Electron's binary is still missing after installing.");
    process.exit(1);
  }
  console.log("Desktop dependencies are installed — `npm start` opens the app.");
  process.exit(0);
}

if (!electronReady()) {
  console.error(
    [
      "Electron could not finish installing, so there is no window to open.",
      "",
      "Fetch the binary by hand:",
      "  cd desktop && node node_modules/electron/install.js",
      "",
      "Or approve the package so npm runs Electron's postinstall itself — on npm",
      "11.16/12 dependency scripts are blocked until then. Either spelling works",
      "and both write `allowScripts` into package.json:",
      "  cd desktop && npm install-scripts approve electron   # npm 11.16+",
      "  cd desktop && npm approve-scripts electron           # npm 12",
    ].join("\n"),
  );
  process.exit(1);
}

if (!existsSync(CLI)) {
  console.error("Electron is missing after installing. Run `cd desktop && npm install`.");
  process.exit(1);
}

console.log("AutoCAT — opening the desktop window…");

// `node cli.js` instead of `.bin/electron`: identical on every platform and it
// does not rely on the launcher keeping its executable bit.
const app = spawnSync(process.execPath, [CLI, "."], { cwd: DESKTOP, stdio: "inherit" });
process.exit(app.status ?? 1);
