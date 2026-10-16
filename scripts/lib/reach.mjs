/**
 * **Which files a program actually needs — walked, not listed.**
 *
 * Both bundles this repo builds carry the catalog server inside something else: the APK
 * carries it as a Node project (`scripts/android-node-folder.mjs`) and the packaged desktop
 * app carries it beside its own `main.js` (`scripts/desktop-server-folder.mjs`). A
 * hand-written list of files is a list that goes stale the first time a module is added, and
 * the failure is a server that will not boot where nobody can read the log — the first cut of
 * the APK bundler died exactly that way, on `scripts/collections.mjs` and then on
 * `scraper/index.js`. So the import graph is followed from the entry point instead, and every
 * local file it reaches comes along.
 *
 * Followed: `import … from "x"`, `export … from "x"`, `await import("x")` and
 * `require("x")`. Not followed: anything bare (`node:fs`, `jsdom`) — an npm package is not a
 * file in this repo, and the app loads the browser tiers with a dynamic `import()` precisely
 * so their absence is survivable.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const SPECIFIERS = /(?:\bfrom\s*|\.\.\.)\s*"([^"]+)"|import\(\s*"([^"]+)"\s*\)|require\(\s*"([^"]+)"\s*\)/g;

/**
 * Every repo-relative module the entry reaches, in discovery order.
 *
 * @param {object} options
 * @param {string} options.root   the repository root (repo-relative paths are returned)
 * @param {string} options.entry  the absolute path of the entry module
 * @param {(rel: string) => boolean} [options.keep] which reached files to hand back
 */
export async function reachableModules({ root, entry, keep = (rel) => /\.(mjs|js|json)$/.test(rel) }) {
  const found = new Set();
  const order = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    const rel = relative(root, file);
    if (rel.startsWith("..") || rel.split(sep)[0] === ".." || found.has(rel)) continue;
    found.add(rel);
    if (keep(rel)) order.push(rel);
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue; // a directory, or something unreadable: nothing to walk
    }
    const specifiers = [...source.matchAll(SPECIFIERS)]
      .map((m) => m[1] || m[2] || m[3])
      .filter((s) => s && s.startsWith("."));
    for (const specifier of specifiers) {
      const next = resolve(dirname(file), specifier.split("?")[0]);
      if (!next.startsWith(root + sep)) continue;
      try {
        if ((await stat(next)).isFile()) queue.push(next);
      } catch {
        /* a path that only exists at run time — nothing to copy */
      }
    }
  }
  return order;
}

/** The absolute path of `rel` under `root`. */
export const under = (root, rel) => join(root, rel);
