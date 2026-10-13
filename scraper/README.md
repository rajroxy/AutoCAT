# scraper/

Paste a page the add-ons do not cover and get its streams: the app's own extractor, tried
in order, cheapest first.

```
scraper/
  index.js      extractStreams(url)        — the tiers, in order, and what answered
  tier1.js      fetchStaticHTML(url)       — one fetch, a browser User-Agent, a 10s deadline
  tier2.js      renderJS(url)              — the page's scripts run in a DOM sandbox (jsdom)
  tier3.js      fetchWithStealth(url)      — a real Chromium, driven over CDP
  finder.js     findStreamsInHTML(html)    — .mp4/.m3u8/.mkv URLs, <video src>, <source src>
  sessions.js   cookies per domain         — earned by one tier, inherited by the next
  plugins.js    rules pasted by the user   — the last word on a site the tiers cannot read
```

Every row is `{ url, quality, title, source }`, and `source` names what produced it —
`direct`, `static`, `js`, `browser`, or `plugin:<name>` — which is what the Sources drawer
shows as "Tier X succeeded".

## Running it

Tier 3 needs Chromium, once:

```sh
npm install                     # playwright, playwright-extra, the stealth plugin
npx playwright install chromium # the browser itself (~120 MB)
```

Tiers 1 and 2 need nothing extra (jsdom is a normal dependency). If Playwright or its
browser is missing, tier 3 answers "no" and the rest keeps working — nothing else in the
app depends on it.

## Plugins

A plugin is a `.js` file at a URL, run once the tiers have all come back empty and only
for the domains it claims:

```js
module.exports = async function extract(url, helpers) {
  const html = await helpers.fetchHTML(url);   // or helpers.renderJS / helpers.browser
  const m = /"file":"([^"]+)"/.exec(html);
  return m ? [{ url: new URL(m[1], url), quality: "1080p", title: "Episode 1" }] : [];
};
```

It runs in a `node:vm` context with no `require`, `process` or `fs`. That is containment
against a plugin that misbehaves — **it is not a security boundary**, and `vm` is
documented as unfit for untrusted code. Paste plugins you trust, from people you trust.

## Where the state lives

`scraper/sessions.json` and `scraper/plugins.json` are runtime state, not source, and are
git-ignored like `addon/settings.json`. Both paths can be overridden for tests with
`AUTOCAT_SESSIONS_FILE` and `AUTOCAT_PLUGINS_FILE`.
