/**
 * The stream extractor's front door.
 *
 * A page the add-ons do not cover can still hold a playable video — a direct file, a
 * playlist, or a `<video>` element a site draws for itself. `extractStreams` is the one
 * entry point the rest of the app calls; how it finds them is the tiers' business, not
 * the caller's:
 *
 *   tier 1  a plain fetch + a regex over the markup   (scraper/tier1.js + finder.js)
 *   tier 2  the page's own scripts run in a DOM sandbox (scraper/tier2.js)
 *   tier 3  a real browser, for the pages neither of those can read (scraper/tier3.js)
 *   plugin  a rule written by hand for one site (scraper/plugins.js), tried last
 *
 * Every answer carries the metadata a stream list needs (`scraper/meta.js`) as well as the
 * URL: quality, format, protocol, domain and a human title — never a UUID, never a bare
 * hash. The **page URL is kept on the row too**, because a page that served this stream
 * usually wants its own `Referer` when something later fetches the file itself.
 *
 * `source` is the tier that produced the row, so the UI can say which one answered.
 */
import { fetchStaticHTML } from "./tier1.js";
import { renderJS } from "./tier2.js";
import { fetchWithStealth, looksLikeChallenge } from "./tier3.js";
import { findStreamsInHTML, unplayableInHTML, isUnplayable } from "./finder.js";
import { pluginFor, runPlugin } from "./plugins.js";
import { describeStream } from "./meta.js";

/** A URL that is already a media file rather than a page to read. */
const MEDIA_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|m3u8|mpd)(?=[?#]|$)/i;

const log = (...args) => {
  if (process.env.AUTOCAT_SCRAPER_QUIET !== "1") console.log("[scraper]", ...args);
};

/**
 * A found URL can be relative (`/media/show.mkv` is what a `<source>` usually holds), and
 * a relative URL is not a stream. It is resolved against the page it was found on.
 */
const absolute = (found, page) => {
  try {
    return new URL(found, page).href;
  } catch {
    return found;
  }
};

/**
 * The tiers, in the order they are tried. Each one is asked only when the one above it
 * came back empty — that ordering is the whole design: the cheap answer first. Each
 * returns the HTML it managed to read, or `null`.
 */
const TIERS = [
  ["static", (page, opts) => fetchStaticHTML(page, opts)],
  ["js", (page, opts) => renderJS(page, opts)],
  ["browser", (page, opts) => fetchWithStealth(page, opts)],
];

/** Describe one found row: the URL plus everything a stream list shows. */
const shapeRow = (found, { tier, page, html }) => {
  const url = absolute(found.url, page);
  return {
    // Whatever the tier already knew about the row is kept — a plugin's own name, for
    // instance — and only the fields this function is responsible for are written over it.
    ...found,
    url,
    ...describeStream(url, { tier, pageUrl: page, pageHtml: html, quality: found.quality, title: found.title }),
    // A plugin names itself (`plugin:<name>`), which says more than the tier word does.
    ...(tier === "plugin" && found.source ? { source: found.source } : {}),
    // Where the stream was found, so the play request can send it as `Referer`.
    referer: page,
    scraped: true,
  };
};

/**
 * @param {string} url
 * @param {{ trace?: string[], cookies?: string }} [options] `trace` collects the same lines
 *   that are logged, so the UI can show which tier answered instead of making the user
 *   read a terminal.
 * @returns {Promise<Array<object>>} the rows, which also carry a non-enumerable
 *   `needsVerification` when every tier was stopped by a bot check.
 */
export async function extractStreams(url, options = {}) {
  const trace = Array.isArray(options.trace) ? options.trace : null;
  const say = (message) => {
    log(message);
    trace?.push(message);
  };
  const page = String(url || "").trim();
  if (!page) {
    say("no URL given");
    return [];
  }

  // A `blob:` or `data:` URL is a page-local object: it cannot be fetched by anything
  // outside the browser that made it, so it is refused here with the reason rather than
  // handed to a player that would show a black frame.
  if (isUnplayable(page)) {
    say(`that is a ${page.split(":")[0]}: URL — a page-local object, not something anything can fetch`);
    return [];
  }

  // Pasting the file itself is the shortest path there is — no page to read, no tier to
  // run. Without this an `.m3u8` URL would be fetched, found to contain no links to a
  // file, and reported as "nothing found" by every tier in turn.
  if (MEDIA_EXT_RE.test(page)) {
    say(`the URL is itself a media file — ${page}`);
    say('tier "direct" succeeded');
    const row = shapeRow({ url: page }, { tier: "direct", page, html: "" });
    const rows = [row];
    Object.defineProperty(rows, "needsVerification", { value: null, enumerable: false });
    return rows;
  }

  // **A budget, for callers that cannot wait.** Search-on-play asks on the Play press,
  // so it cannot let three tiers run to their own timeouts one after another: it passes a
  // deadline (and, with no verified cookies for the site, a highest tier to try). Every
  // tier above the ceiling is skipped rather than run and discarded.
  const deadline = Number(options.deadline) || 0;
  const ceiling = String(options.maxTier || "") ;
  const ceilingAt = ceiling ? TIERS.findIndex(([t]) => t === ceiling) : TIERS.length - 1;
  let blocked = null;
  for (const [name, read] of TIERS) {
    if (TIERS.findIndex(([t]) => t === name) > ceilingAt) {
      say(`tier "${name}" skipped — past this caller's ceiling (${ceiling})`);
      continue;
    }
    if (deadline && Date.now() >= deadline) {
      say(`tier "${name}" skipped — out of time`);
      continue;
    }
    let html = null;
    try {
      html = await read(page, { cookies: options.cookies, referer: page, timeout: options.timeout });
    } catch (err) {
      say(`tier "${name}" failed — ${err?.message || err}`);
      continue;
    }
    if (!html) {
      say(`tier "${name}" found nothing`);
      continue;
    }
    // **A bot check is not a page.** Reporting it as "nothing found" hides the one fact
    // that matters — that the site is asking for a human — so it is recorded and passed
    // back, and the UI can offer the manual step.
    if (name === "browser" && looksLikeChallenge(html)) {
      blocked = { url: page, domain: new URL(page).hostname };
      say(`tier "${name}" was stopped by a bot check on ${blocked.domain}`);
      break;
    }
    const unplayable = unplayableInHTML(html);
    if (unplayable.length) {
      say(`ignoring ${unplayable.length} page-local (blob:/data:) URL(s) — they cannot be fetched`);
    }
    const found = findStreamsInHTML(html);
    if (found.length) {
      say(`tier "${name}" succeeded — ${found.length} stream(s) from ${page}`);
      for (const s of found) log(`  extracted ${s.url}`);
      const rows = found.map((s) => shapeRow(s, { tier: name, page, html }));
      Object.defineProperty(rows, "needsVerification", { value: null, enumerable: false });
      return rows;
    }
    say(`tier "${name}" found nothing`);
  }

  // **The last word belongs to the site.** If nothing general could read the page, a
  // plugin written for it is the answer — and if there is none, saying so is the answer.
  const plugin = pluginFor(page);
  if (plugin) {
    const result = await runPlugin(page, plugin);
    if (result.streams.length) {
      say(`plugin "${result.plugin}" succeeded — ${result.streams.length} stream(s) from ${page}`);
      for (const s of result.streams) log(`  extracted ${absolute(s.url, page)}`);
      const rows = result.streams.map((s) => shapeRow(s, { tier: "plugin", page, html: "" }));
      Object.defineProperty(rows, "needsVerification", { value: null, enumerable: false });
      return rows;
    }
    say(`plugin "${result.plugin}" found nothing${result.message ? ` — ${result.message}` : ""}`);
  }
  say(blocked ? `no tier could read ${page} — it wants manual verification` : `no tier found a stream on ${page}`);
  const rows = [];
  Object.defineProperty(rows, "needsVerification", { value: blocked, enumerable: false });
  return rows;
}
