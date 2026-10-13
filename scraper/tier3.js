/**
 * Tier 3 — a real browser, when nothing else can read the page.
 *
 * The tiers below this one are honest attempts at being cheap: a fetch, then a DOM
 * sandbox. Both fail on the same class of page — one that only works in a real engine
 * (canvas, WebGL, a bot check) — and that is what this tier is: Chromium, driven over
 * CDP, waiting for the page to finish talking to the network, handing back the HTML a
 * visitor would have got.
 *
 * Two things make it usable rather than theoretical:
 *
 * 1. **The stealth plugin.** A default headless Chromium announces itself (navigator
 *    flags, missing plugins, a driver in the connection) and a site that checks for it
 *    serves a challenge instead of a video. The plugin removes those tells, so the page
 *    renders. Use this only on sites you are allowed to read: a site that asks not to be
 *    automated is telling you something, and it is your call whether you may anyway.
 * 2. **One browser, borrowed.** Launching Chromium costs a second and a few hundred
 *    megabytes; a page that needed tier 3 usually needs it again a moment later. The
 *    process is kept alive between calls and shut down after a minute of quiet.
 *
 * This tier is optional. If Playwright or its browser is not installed, the function
 * answers `null` with a reason, and the app keeps working exactly as it did.
 */
import { BROWSER_UA } from "./tier1.js";
import { playwrightCookies } from "./sessions.js";
import { activeDnsServers, resolveHost } from "../addon/dns.mjs";

const DEFAULT_TIMEOUT_MS = Number(process.env.AUTOCAT_SCRAPER_BROWSER_TIMEOUT_MS) || 30000;
const IDLE_SHUTDOWN_MS = 60000;
/** How many times a bot-check page is given a moment to hand over the real one. */
const CHALLENGE_RETRIES = 6;

/**
 * The words an interstitial uses. Deliberately narrow: a real article that mentions
 * "checking your browser" is not a challenge, and calling it one would make this tier
 * re-read a page it already has.
 */
const CHALLENGE_RE = /just a moment|checking your browser|enable javascript and cookies|cf-chl|_cf_chl_opt|attention required/i;
/**
 * What a stream looks like from the outside.
 *
 * A media segment list, a DASH manifest, or a container file — the addresses a player can
 * be pointed at. Deliberately narrow: a page's own `.js` is not a stream, and calling one
 * a stream would put a script URL in the Sources list.
 */
const MEDIA_URL_RE = /\.(?:m3u8|mpd|mp4|mkv|webm|avi|ts)(?:\?|#|$)/i;

/**
 * What a title opened **as a modal** looks like. Several of these sites never navigate to a
 * title: the card opens a dialog over the search page, and the dialog is where Play lives.
 * One constant, so the three places that wait for it cannot drift apart.
 */
const DIALOG_SELECTOR = "[role=dialog], [data-vaul-drawer-visible=true], [aria-haspopup=dialog][data-state=open]";

/** Is this the interoperable interstitial rather than the page? */
export const looksLikeChallenge = (html) => CHALLENGE_RE.test(String(html || ""));

let browserPromise = null;
/** The **browser object** behind that promise — see the `disconnected` handler below. */
let liveBrowser = null;
let idleTimer = null;
let loadedStealth = false;
/** The resolver mapping the live browser was launched with, so a change relaunches it. */
let launchedWith = "";

/** Why the last attempt could not run, so the UI can say something true. */
let lastError = "";
export const browserUnavailableReason = () => lastError;

/**
 * The browser, launched once and reused.
 *
 * `playwright-extra` + the stealth plugin when they are installed; plain Chromium
 * otherwise. A plain headless browser still renders most pages — it is only the sites
 * that actively look for automation that need the disguise.
 */
async function browser(host = "") {
  // **The DNS override reaches the browser too.** Chromium has no "use this resolver"
  // flag, but `--host-resolver-rules` maps a host to an address after resolution — and
  // SNI still comes from the URL, so TLS is unaffected. A different host means a
  // different mapping, and a different mapping means a fresh browser.
  let rules = "";
  const servers = activeDnsServers();
  if (servers.length && host) {
    const found = await resolveHost(host, servers).catch(() => ({ ok: false }));
    if (found.ok && found.ip) rules = `MAP ${host} ${found.ip}`;
  }
  const key = `${rules}`;
  // **A browser that died is not a browser.** A page can take the renderer down with it
  // (heavy canvas work, a bot check, a site doing something a headless shell cannot) and
  // the process can go between two calls. Checking here, before handing out the cached
  // promise, is what makes the next call relaunch instead of failing with "Target page,
  // context or browser has been closed" — a message that means nothing to whoever pressed
  // Play, and that used to be the whole answer for a site that had killed the last one.
  if (browserPromise && (!liveBrowser || !liveBrowser.isConnected())) {
    browserPromise = null;
    liveBrowser = null;
  }
  if (browserPromise && key !== launchedWith) {
    const old = browserPromise;
    browserPromise = null;
    liveBrowser = null;
    try {
      await (await old)?.close();
    } catch {
      /* already gone */
    }
  }
  if (!browserPromise) {
    launchedWith = key;
    browserPromise = (async () => {
      let chromium;
      try {
        const extra = await import("playwright-extra");
        chromium = (extra.default || extra).chromium;
        if (!loadedStealth) {
          const plugin = await import("puppeteer-extra-plugin-stealth");
          chromium.use((plugin.default || plugin)());
          loadedStealth = true;
        }
      } catch {
        // No playwright-extra: the plain driver is still a real browser.
        const playwright = await import("playwright");
        chromium = (playwright.default || playwright).chromium;
      }
      const launched = await chromium.launch({
        headless: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          ...(rules ? [`--host-resolver-rules=${rules}`] : []),
        ],
      });
      /**
       * **A browser that died is not a browser to hand out again.**
       *
       * A page can take the renderer down with it (heavy WebGL, a bot check, a site doing
       * something a headless shell cannot), and the process can go between two calls. The
       * cached promise then points at a corpse, and every later scrape fails with "Target
       * page, context or browser has been closed" — a message that means nothing to
       * whoever pressed Play. Dropping the cache here means the next call launches a fresh
       * one, and the site that killed the last browser is a site, not an outage.
       */
      launched.on("disconnected", () => {
        // **The promise is not the browser.** This used to compare `browserPromise` (a
        // promise) with `launched` (a browser), which never matched — so a dead process
        // stayed in the cache and every later scrape inherited it.
        if (liveBrowser === launched) {
          liveBrowser = null;
          browserPromise = null;
        }
      });
      liveBrowser = launched;
      return launched;
    })().catch((err) => {
      // A failed launch must not be cached: the next attempt deserves a fresh one.
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/** Close the browser once nobody has asked for it for a minute. */
function armIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const pending = browserPromise;
    browserPromise = null;
    try {
      const b = await pending;
      await b?.close();
    } catch {
      /* already gone */
    }
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

/**
 * Load a page in a real browser and return its final HTML.
 *
 * @param {string} url
 * @param {{ timeout?: number, cookies?: Array<object>, referer?: string, detailed?: boolean }} [options]
 * @returns {Promise<string|null|{html: string|null, challenge: boolean}>} the HTML, or —
 *   with `detailed: true` — the HTML and whether it is a bot-check interstitial.
 */
export async function fetchWithStealth(url, options = {}) {
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT_MS;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  lastError = "";
  let context = null;
  const done = (html) => {
    const challenge = Boolean(html) && looksLikeChallenge(html);
    return options.detailed ? { html: html || null, challenge } : html || null;
  };
  try {
    const b = await browser(host);
    armIdleShutdown();
    context = await b.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    });
    // A session earned earlier (scraper/sessions.js) — a cookie-consent wall or an
    // age gate answered once should not have to be answered again.
    const cookies = Array.isArray(options.cookies) ? options.cookies : playwrightCookies(url);
    if (cookies.length) {
      await context.addCookies(cookies).catch(() => {});
    }
    const page = await context.newPage();
    try {
      // The page is its own referrer: a site that hands its player a file only to a
      // request from its own page is the common case, and the browser should look like
      // one that navigated rather than one that arrived from nowhere.
      if (options.referer) await page.setExtraHTTPHeaders({ referer: String(options.referer) }).catch(() => {});
      await page.goto(url, { waitUntil: "networkidle", timeout });
    } catch {
      // A page that never goes quiet (a poller, a websocket) still has a DOM worth
      // reading. The timeout is the deadline for *the page settling down*, not for the
      // tier failing; only an empty document is a failure.
    }
    /**
     * **A challenge page is not an answer.** Sites that put an interstitial in front of
     * the real page hand it over only after their own script has run; reading
     * `content()` the instant the network goes quiet catches the interstitial. This
     * waits, briefly and a bounded number of times, for the page to become a page —
     * and then reports whatever is there, challenge or not. Nothing here tries to
     * defeat a check that is refusing us: it waits for the site's own script to finish.
     */
    let html = await page.content();
    let unchanged = 0;
    for (let i = 0; i < CHALLENGE_RETRIES && looksLikeChallenge(html) && unchanged < 2; i += 1) {
      await page.waitForTimeout(1200);
      const next = await page.content();
      // A page that is not changing is not about to: two identical reads end the wait
      // rather than spending the whole budget on a site that has decided to refuse us.
      unchanged = next === html ? unchanged + 1 : 0;
      html = next;
    }
    return done(html);
  } catch (err) {
    lastError = String(err?.message || err).split("\n")[0];
    return done(null);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

/**
 * **Search a site the way a person does.**
 *
 * A search page is not a page with results on it: it is an application that draws them
 * after its own scripts have run, and whose results are often **not links at all** — a
 * poster in a `<div>` with a click handler, a card that only becomes a URL once you open
 * it. Fetching that page cannot see it, and neither can the DOM sandbox: they return the
 * shell, and the site's own catalogue looks empty. (`shuttletv.su/search?q=…` has four
 * results in a browser and none in either of the cheaper tiers.)
 *
 * So: open the search page in the real browser, wait for it to settle, collect the cards
 * it drew, hand them to the caller's scorer, and open the one it picks — following either
 * the card's own `href` or a real click, which is what the site is waiting for.
 *
 * @param {string} url the site's own search URL, built by the caller from its search form
 * @param {object} [options]
 * @param {(card: {text: string, alt: string}) => number} [options.score] picks the card
 * @param {number} [options.timeout] how long the page may take to arrive
 * @param {number} [options.settle] how long to give the results to be drawn
 * @param {string|Array<object>} [options.cookies]
 * @returns {Promise<{url: string|null, html: string|null, matched: object|null, cards: number, error?: string}>}
 *   the page the best match leads to and its HTML (`url` is `null` when nothing matched),
 *   plus what was on offer — so a caller can say "4 results, none of them this title".
 */
/** What a dead browser says, on any of the three layers that can report it. */
const DEAD_BROWSER_RE = /has been closed|Target closed|browser has been closed|Protocol error|Session closed|crash/i;

/**
 * **Try it; if the browser itself died, get a new one and try again.**
 *
 * A heavy page can kill the renderer, and the whole process with it: the run fails at
 * whatever line it had reached, with a message about a closed target. One relaunch turns
 * that from "this site cannot be searched" into "this site was searched" — and the second
 * attempt reads a lighter page, because images, media and fonts are not fetched at all
 * any more (see `keepItLight`).
 */
export async function browserSearch(url, options = {}) {
  const trace = browserTrace;
  const started = Date.now();
  let out = await browserSearchOnce(url, options);
  if (trace) console.error(`[scraper] browser ${url} → cards=${out?.cards ?? "-"} media=${out?.media?.length ?? 0} ${out?.error ? `error=${out.error}` : "ok"} (${Date.now() - started}ms)`);
  if (out?.error && DEAD_BROWSER_RE.test(out.error)) {
    // **The page took the renderer down.** Not a verdict on the site: a fresh browser and
    // one more read, and the caller hears about the second attempt rather than the first.
    if (trace) console.error(`[scraper] browser died on ${url} — relaunching for one more read`);
    const first = out;
    await dropBrowser();
    out = await browserSearchOnce(url, options);
    if (trace) console.error(`[scraper] browser retry ${url} → cards=${out?.cards ?? "-"} media=${out?.media?.length ?? 0} ${out?.error ? `error=${out.error}` : "ok"} (${Date.now() - started}ms total)`);
    // **The first attempt's findings are kept when the second has none.** A page that dies
    // once tends to die again; what the first pass saw before it went is the answer.
    if (out?.error && ((first.media?.length || 0) > (out.media?.length || 0) || (first.embeds?.length || 0) > (out.embeds?.length || 0))) {
      out = { ...out, media: first.media?.length ? first.media : out.media, embeds: first.embeds?.length ? first.embeds : out.embeds, url: out.url || first.url, matched: out.matched || first.matched };
    }
  }
  return out;
}

/** Set `AUTOCAT_SCRAPER_TRACE=1` to see what this tier did with each page, on stderr. */
const browserTrace = Boolean(process.env.AUTOCAT_SCRAPER_TRACE);

/** Let go of the shared browser: the next caller launches a fresh one. */
async function dropBrowser() {
  const dead = liveBrowser;
  liveBrowser = null;
  browserPromise = null;
  clearTimeout(idleTimer);
  try {
    await dead?.close();
  } catch {
    /* it is already gone — that is why we are here */
  }
}

/**
 * **The page is read the way a browser reads it — nothing is blocked.**
 *
 * Routing every request through a JS handler and aborting the heavy ones (`image`,
 * `media`, `font`) was tried here to keep a big results page cheap. It took this Chromium
 * down instead: `trap int3` in the renderer, the whole process gone in under three seconds,
 * on exactly the two sites it was added for. Switching images off in the engine
 * (`--blink-settings=imagesEnabled=false`) survived, but a poster that never arrives can
 * leave the box holding it with nothing to click — and the click is what opens these
 * sites' players. So nothing is blocked; the tier simply survives a page that kills the
 * renderer by relaunching once (see `browserSearch`).
 */

async function browserSearchOnce(url, options = {}) {
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT_MS;
  const settle = Number(options.settle) || 4000;
  const score = typeof options.score === "function" ? options.score : null;
  // **A score above zero is not a match.** The title scorer awards a small bonus for the
  // word "movie" or "watch" appearing on a card, so on a film site every card scores
  // something — and treating that as a match opens a random result. Half the title's words
  // is the floor.
  const minScore = Number(options.minScore) || 0.4;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  lastError = "";
  let context = null;
  // **What was learned before the crash is still worth keeping.** A page can kill the
  // renderer half-way through being driven, and the watch address it opened, the media URL
  // it asked for and the embed it handed off to are all *findings* — throwing them away
  // because a later line failed is how "this site cannot be searched" was reported for a
  // site whose player had already been reached.
  let media = [];
  let embeds = [];
  let pressed = "";
  const fail = (why) => ({ url: null, html: null, matched: null, cards: 0, media, embeds, pressed, error: why });
  try {
    const b = await browser(host);
    armIdleShutdown();
    context = await b.newContext({ userAgent: BROWSER_UA, viewport: { width: 1366, height: 900 }, locale: "en-US" });
    const cookies = Array.isArray(options.cookies) ? options.cookies : playwrightCookies(url);
    if (cookies.length) await context.addCookies(cookies).catch(() => {});
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      // Best effort, and **short on purpose**: a results page with a poller or a socket
      // never goes idle, and a heavy one can take the renderer down while we wait for it
      // to. The DOM is read in the loop below instead — three passes, each one waiting a
      // little longer, which finds the results sooner than a long idle ever did.
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 4000) }).catch(() => {});
    } catch {
      /* the DOM below is the deadline's answer either way */
    }

    let cards = [];
    let best = null;
    // **Look, wait, look again.** A results list can arrive a beat after `load`; two more
    // passes cost a few seconds and are the difference between "no results" and results.
    // **Wait for the page to have drawn them, then look, then look again.** ...
    for (let attempt = 0; attempt < 3 && !best; attempt += 1) {
      await page.waitForTimeout(attempt === 0 ? Math.min(settle, 1500) : 2500);
      cards = await page.evaluate(collectSearchCards);
      if (browserTrace) {
        const line = !score || !cards.length
          ? `${cards.length} card(s)`
          : cards.map((c) => ({ c, s: Number(score(c)) || 0 })).sort((a, b) => b.s - a.s).slice(0, 3).map((r) => `${r.s.toFixed(2)} "${r.c.text.slice(0, 46)}"`).join(" | ");
        console.error(`[scraper]   ${url} pass ${attempt}: ${line}`);
      }
      if (!score || !cards.length) continue;
      const ranked = cards.map((c) => ({ c, s: Number(score(c)) || 0 })).sort((a, b) => b.s - a.s);
      if (ranked[0].s >= minScore) best = ranked[0].c;
    }

    if (!best) {
      // Nothing matched: hand back the page we ended up with, and how much was on it.
      return { url: null, html: await page.content(), matched: null, cards: cards.length };
    }

    // **Everything the page asks for from here on.** A stream on one of these sites is
    // rarely in the markup: it is a request the site's own player makes after it is told
    // to play — often from inside an embed's iframe, which the browser reports too. What
    // comes back is the address the app can hand to a player.
    media = [];
    const noteMedia = (url) => {
      if (!MEDIA_URL_RE.test(url)) return;
      if (media.length < 12 && !media.includes(url)) media.push(url);
    };
    page.on("request", (req) => noteMedia(req.url()));

    /**
     * **The player's own hand-off, caught before it can take the browser with it.**
     *
     * A stream on a site like this is rarely the page's: pressing Play navigates to a watch
     * page whose `<iframe>` is on *another host* — an embed that fetches the media itself.
     * That embed is often heavier than everything before it put together, and on this
     * machine reading one kills the renderer outright (`cinesrc.st` takes the process down
     * in about a second). So the address is **recorded as it appears**, and the caller can
     * hand it to a tier that does not need a browser at all.
     */
    embeds = [];
    const noteEmbeds = async () => {
      const list = await page
        .evaluate(() => [...document.querySelectorAll("iframe[src]")].map((f) => f.src))
        .catch(() => []);
      for (const src of list) {
        if (!src || src === "about:blank" || embeds.includes(src)) continue;
        if (embeds.length < 6) embeds.push(src);
      }
    };

    // The card's own link, when it has one.
    if (best.href) {
      try {
        await page.goto(best.href, { waitUntil: "domcontentloaded", timeout });
        await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 15000) }).catch(() => {});
      } catch {
        /* fall through to the click: the href may refuse a direct visit */
      }
    }
    let landed = page.url();
    if (landed === url || !best.href) {
      // **A card that is not a link.** A real mouse click, on the card's own coordinates:
      // these cards are `<div>`s with a pointer handler, and a synthetic `click()` on the
      // poster inside them is not the event half of them listen for.
      const before = page.url();
      // **Through Playwright's own click**, not a coordinate: these cards sit on pages
      // that hijack scrolling, so the position measured a moment ago is not where the card
      // is by the time a mouse arrives. `click` scrolls it in, waits for it to hold still,
      // and then presses — and falls back to the element's own event when that is refused.
      const card = page.locator(`[data-autocat-card="${best.index}"]`).first();
      // **`force: true`, because a cover is not a reason to refuse the click.** Playwright's
      // own click first waits for the element to be visible, still and *receiving* events —
      // and these posters almost always have something over them: a hover row, a rating, a
      // scaled-up wrapper. That check then times out on a card a person clicks without
      // thinking, and the run ends with no stream. Force skips the checks and presses at the
      // element's own centre, which is what the mouse does; the two fallbacks below still
      // stand in when even that lands on the wrong thing.
      await card.click({ timeout: 8000, force: true }).catch(async () => {
        const box = await page.evaluate((index) => {
          const el = document.querySelector(`[data-autocat-card="${index}"]`);
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, best.index).catch(() => null);
        if (box) await page.mouse.click(box.x, box.y).catch(() => {});
        else await page.evaluate((index) => document.querySelector(`[data-autocat-card="${index}"]`)?.click(), best.index).catch(() => {});
      });
      try {
        // A **dialog** counts as arriving: several of these sites open the title as a
        // modal over the search page rather than navigating to it.
        await page.waitForURL((u) => String(u) !== before, { timeout: 6000 }).catch(async () => {
          await page.waitForSelector(DIALOG_SELECTOR, { timeout: 6000 }).catch(() => {});
        });
        // **No `networkidle` here.** A search-driven modal has a poller or a socket open, so
        // "idle" never arrives and this used to sit here for its whole twelve-second
        // deadline on every play — long enough for a heavy page to kill the renderer while
        // nothing useful was happening. The dialog is waited for below, where it matters.
      } catch {
        /* the card may simply have done nothing */
      }
      landed = page.url();
      if (browserTrace) console.error(`[scraper]   ${url} card opened → ${landed === url ? "still on the search page" : landed.slice(0, 90)}`);
    }

    // **Press Play, once.** On a page or a modal that has one, that is the only step that
    // makes the player ask for the stream — and the requests above are what it is asked for.
    // A modal that is drawn a beat after the click: wait for it, bounded, rather than
    // reading the page in the instant the URL changed and concluding there is no Play.
    await page
      .waitForSelector(DIALOG_SELECTOR, { timeout: 6000 })
      .then(() => page.waitForTimeout(800))
      .catch(() => {});

    // **Press Play.** Inside the modal when the site opened one (that is where a media
    // site puts it), otherwise only when the page has exactly one — a listing can carry a
    // Play per row, and pressing the wrong one is worse than pressing none.
    pressed = await page
      .evaluate(() => {
        const PLAY_RE = /^(?:▶\s*)?(?:play|watch now|watch|stream)$/i;
        const named = (nodes) => [...nodes].filter((b) => PLAY_RE.test((b.textContent || "").trim()));
        const dialog = document.querySelector("[role=dialog]");
        const scope = dialog || document;
        let hits = named(scope.querySelectorAll("button, a, [role=button]"));
        if (!hits.length && dialog) hits = named(dialog.querySelectorAll("*")).filter((b) => b.children.length < 6);
        if (!dialog && hits.length !== 1) return "";
        if (!hits.length) return "";
        hits[0].click();
        return (hits[0].textContent || "").trim().slice(0, 30);
      })
      .catch(() => "");
    if (browserTrace) console.error(`[scraper]   ${url} play pressed=${JSON.stringify(pressed)} dialogs=${await page.evaluate(() => document.querySelectorAll(DIALOG_SELECTOR).length).catch(() => "?")}`);
    if (pressed) {
      await noteEmbeds();
      // **As long as it takes, and not a moment longer.** The embed has to load and make its
      // own request; the moment one arrives the wait is over, so a player that answers in a
      // second costs a second. Bounded, because a player that never answers is a site with
      // nothing to give and the caller has a search to finish.
      for (let i = 0; i < 20 && !media.length; i += 1) {
        await page.waitForTimeout(600);
        if (i % 2 === 1) await noteEmbeds();
      }
      if (browserTrace) console.error(`[scraper]   ${url} player produced ${media.length} media url(s), embeds=${embeds.length}`);
    }
    return { url: landed !== url ? landed : null, html: await page.content(), matched: best, cards: cards.length, media, embeds, pressed };
  } catch (err) {
    lastError = String(err?.message || err).split("\n")[0];
    return fail(lastError);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

/**
 * The cards on a search page, as the browser sees them.
 *
 * Runs in the page. A result on a media site is a **poster**, so `img[alt]` finds them,
 * and the text of the box around it is the title and year the caller scores. Links with
 * text but no image are collected too — a list-style site has results that way. Each card
 * is tagged with an index so the picking side can click it after the fact.
 */
function collectSearchCards() {
  const out = [];
  const seen = new Set();
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  /**
   * **A card's words, with the boundaries still in them.**
   *
   * `textContent` glues a card together: `<div>Oppenheimer</div><div>2023 • movie</div>`
   * reads as `Oppenheimer2023•movie` — one long token, in which the title is not a word
   * that can be matched. The scorer looks for the title as a word, so a card that really
   * reads "Oppenheimer 2023 • movie" scored 0.4 — just under the floor — and a page whose
   * four results were all drawn that way came back as no match at all. Reading the leaves
   * and joining them with a space is what puts the title back.
   */
  const wordsIn = (el) => {
    const parts = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.children.length) walk(child);
        else {
          const t = clean(child.textContent);
          if (t) parts.push(t);
        }
      }
    };
    walk(el);
    return parts.join(" ");
  };
  const push = (el, text, href, alt) => {
    const key = `${clean(text).slice(0, 60)}|${href || ""}|${clean(alt)}`;
    if (seen.has(key)) return;
    seen.add(key);
    el.setAttribute("data-autocat-card", String(out.length));
    out.push({ index: out.length, text: clean(text).slice(0, 160), href: href || "", alt: clean(alt).slice(0, 120) });
  };

  /**
   * **The card is the smallest thing around the picture that carries words.**
   *
   * A poster on these sites is one `<div>` holding the `<img>` (and the hover buttons),
   * and the title and year are in a *sibling* of that div — so the box the picture sits in
   * has no text at all, and a card built from it scores zero however good the title is.
   * That is why a page with four visible results used to come back as "0 cards". Walking
   * up from the picture to the nearest ancestor with words is what finds the card: the
   * first ancestor whose text is short enough to be one card and not the whole grid.
   */
  const cardAround = (node) => {
    let el = node.parentElement;
    const fallback = el;
    for (let i = 0; i < 5 && el && el !== document.body; i += 1) {
      // A grid of results contains many pictures; a card contains one or two. The count is
      // what tells them apart when the words alone would let the grid pass.
      const heavy = el.querySelectorAll("img, picture, video").length > 6;
      const text = clean(el.textContent);
      if (!heavy && text.length >= 3 && text.length <= 220) return el;
      el = el.parentElement;
    }
    return fallback;
  };

  // **Every picture, not only the labelled ones.** `img[alt]` missed these sites entirely:
  // their posters are drawn with an empty or missing `alt`, and the title lives in the
  // text beside them.
  for (const img of document.querySelectorAll("img")) {
    const box = cardAround(img);
    if (!box) continue;
    const link = box.tagName === "A" && box.href ? box.href : box.querySelector?.("a[href]")?.href || "";
    // **The poster is what is clicked**, not the box around it: the box usually carries a
    // hover row of its own (a "+" to add to a list, a rating), and a click in the middle of
    // it lands on whichever of those the site put there. A person clicks the picture.
    push(img, wordsIn(box) || box.textContent || "", link, img.getAttribute("alt") || img.getAttribute("title"));
  }
  for (const a of document.querySelectorAll("a[href]")) {
    const text = a.textContent || "";
    if (!text.trim() || text.length > 140) continue;
    push(a, text, a.href, a.querySelector("img")?.getAttribute("alt") || "");
  }
  // **A card that is neither a link nor a picture** — a row-style result drawn as a `div`
  // with a pointer handler, which is what both of the sites this tier exists for use.
  for (const el of document.querySelectorAll("[class*=card], [class*=result], [class*=tile]")) {
    const text = clean(el.textContent);
    if (text.length < 3 || text.length > 140) continue;
    if (el.querySelectorAll("img, [class*=card]").length > 4) continue;
    push(el, wordsIn(el) || text, el.querySelector("a[href]")?.href || "", "");
  }
  return out;
}
