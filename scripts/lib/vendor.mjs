/**
 * **Copy the npm packages a packaged build needs into the build.** 
 *
 * Both packaged builds carry the server's *modules* (`reachableModules` walks the import graph)
 * and neither carried its **dependencies**: from a checkout the server resolves `cheerio` and
 * `torrent-stream` out of the repository's own `node_modules`, and inside an APK or an installed
 * app there is no repository above the modules. That is exactly why a torrent was "the server has
 * no torrent engine" on Android TV and why a Nuvio provider that parses HTML fell over at its
 * first line.
 *
 * So the packages are **copied**, dependency-first, from wherever they are installed here:
 *
 *   `torrent-stream`  the pure-JavaScript torrent engine — the one the APK can actually run,
 *                     because WebTorrent needs `node-datachannel`, a native module, which cannot
 *                     be built on a device
 *   `cheerio`         what a provider bundled for Nuvio expects under the name
 *                     `cheerio-without-node-native` (`pluginvm.mjs` maps the name onto it)
 *
 * A package that is not installed locally is reported by name and skipped — never silently
 * assumed — because the failure it would cause on the device is a provider that answers nothing.
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where a package may have been installed, in the order they are tried. */
const roots = (from) => from.filter(Boolean);

/** The directory a package lives in, or `null` when it is not installed here. */
function findPackage(name, from) {
  for (const root of roots(from)) {
    const dir = join(root, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}

const manifestOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return {};
  }
};

/**
 * Every package name `packages` needs, dependencies first.
 *
 * Only `dependencies` are walked: `devDependencies` are a build-time thing, `peerDependencies`
 * are satisfied by whoever installed it (and are usually the runtime itself), and
 * `optionalDependencies` are exactly the native modules this is avoiding.
 */
/**
 * **Every directory Node itself would look in**, from a package outward: its own
 * `node_modules`, then the `node_modules` of each directory above it, then the install roots
 * this app was handed.
 *
 * This is the part that is easy to get wrong and expensive to get wrong: `parse-torrent` under
 * `torrent-stream` requires `magnet-uri`, and npm put that copy in
 * `torrent-stream/node_modules/` — the **parent's** `node_modules`, not its own. Looking only
 * beside the package that asked is how `thirty-two` went missing from the packaged engine, and
 * "Cannot find module 'thirty-two'" was the first magnet on a TV.
 */
function lookupDirs(dir, from) {
  const out = [];
  let at = dir;
  while (at && at !== dirnameOf(at)) {
    out.push(at.endsWith("node_modules") ? at : join(at, "node_modules"));
    at = dirnameOf(at);
  }
  return [...new Set([...out, ...from])];
}

const dirnameOf = (dir) => dir.replace(/\/[^/]*$/, "") || "/";

function dependencyGraph(packages, from) {
  const ordered = [];
  const seen = new Set();
  const missing = new Set();
  const visit = (name, dir = "") => {
    let found = null;
    if (dir) {
      for (const where of lookupDirs(dir, [])) {
        const at = join(where, name);
        if (existsSync(join(at, "package.json"))) {
          found = at;
          break;
        }
      }
    }
    const resolved = found || findPackage(name, from);
    if (!resolved) {
      missing.add(name);
      return;
    }
    // Keyed by **directory**, not by name: two copies of one package at different versions are
    // two different packages, and both have to be walked.
    if (seen.has(resolved)) return;
    seen.add(resolved);
    // **A package's own dependencies are walked whatever its own placement.** A nested copy
    // travels with its top-level ancestor when that is copied (`cp` takes a package's
    // `node_modules` along), but a dependency npm hoisted to the install root does not — and a
    // walk that stopped at "it is nested, it travels" is exactly the missing `thirty-two`.
    for (const dep of Object.keys(manifestOf(resolved).dependencies || {})) visit(dep, resolved);
    // Copy only what the install roots hold: anything else already travels with its ancestor.
    if (from.includes(dirnameOf(resolved))) ordered.push({ name, dir: resolved });
  };
  for (const name of packages) visit(name);
  return { ordered, missing: [...missing] };
}

const sizeOf = async (dir) => {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(at);
    else if (entry.isFile()) total += (await stat(at)).size;
  }
  return total;
};

/**
 * Copy `packages` and everything they need into `<into>/node_modules`.
 *
 * The tree is copied flat — every package at the top level, which is what npm's own deduping
 * produces for these two — and a package already there is left alone, so running this twice
 * costs nothing and the second copy cannot half-overwrite the first.
 */
export async function vendorModules({ into, packages, from = [], remove = true }) {
  const nodeModules = join(into, "node_modules");
  if (remove) await rm(nodeModules, { recursive: true, force: true });
  await mkdir(nodeModules, { recursive: true });

  const { ordered, missing } = dependencyGraph(packages, from);
  const copied = [];
  let bytes = 0;
  for (const { name, dir } of ordered) {
    const to = join(nodeModules, name);
    await cp(dir, to, { recursive: true });
    const size = await sizeOf(to);
    bytes += size;
    copied.push({ name, version: String(manifestOf(dir).version || ""), size });
  }
  return { copied, missing, bytes, dir: nodeModules };
}
