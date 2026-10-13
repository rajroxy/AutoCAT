#!/usr/bin/env node
/**
 * Cover-art direction preview.
 *
 * Renders the SAME three collections through two candidate imagery treatments so
 * they can be compared like-for-like, then writes a comparison gallery.
 *
 *   Option 1 — Split Panel    : real photo beside the text, light-black field.
 *   Option 3 — Duotone Bleed  : real photo full-bleed, graded to one monochrome
 *                               tone, text over it.
 *
 * Output: covers/_options/option-1/*, covers/_options/option-3/*, index.html
 *
 * Run with:  node preview-options.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);
const opentype = require("opentype.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FONT_DIR = path.join(__dirname, "fonts");
const OUT = path.join(ROOT, "covers", "_options");
const PHOTOS = path.join(OUT, "photos");

const W = 1920;
const H = 1080;
const PAD = 140;

/* ------------------------------------------------------------------ fonts */

const FONT_FILES = [
  { weight: 500, file: "Inter-Medium.ttf" },
  { weight: 600, file: "Inter-SemiBold.ttf" },
  { weight: 700, file: "Inter-Bold.ttf" },
  { weight: 800, file: "Inter-ExtraBold.ttf" },
  { weight: 900, file: "Inter-Black.ttf" },
];
const fontFiles = FONT_FILES.map((f) => path.join(FONT_DIR, f.file));
const loadedFonts = FONT_FILES.map((f) => {
  const buf = fs.readFileSync(path.join(FONT_DIR, f.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { weight: f.weight, font: opentype.parse(ab) };
});
function pickFont(weight) {
  let best = loadedFonts[0];
  for (const f of loadedFonts) if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f;
  return best.font;
}
function measure(text, size, weight, letterSpacing = 0) {
  const font = pickFont(weight);
  let units = 0;
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    units += g && g.advanceWidth ? g.advanceWidth : font.unitsPerEm * 0.52;
  }
  return (units * size) / font.unitsPerEm + letterSpacing * text.length;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ----------------------------------------------------------------- design */

const INK = "#08090C"; // light-black, matches the AutoCAT home field
const KICK_COL = "rgba(255,255,255,0.55)";
const ACCENT = "#C8A96A"; // a single restrained champagne accent, used sparingly

function titleSize(lines, maxW) {
  const base = lines.length === 1 ? 250 : 186;
  let size = base;
  const track = -0.035;
  for (;;) {
    const ls = track * size;
    const widest = Math.max(...lines.map((l) => measure(l, size, 800, ls)));
    if (widest <= maxW || size <= 40) break;
    size -= 2;
  }
  return size;
}

function titleBlock(lines, x, yCenter, maxW, weight = 800) {
  const size = titleSize(lines, maxW);
  const ls = -0.035 * size;
  const lineH = size * 0.96;
  const blockH = (lines.length - 1) * lineH + size;
  const top = yCenter - blockH / 2;
  const firstBase = top + size * 0.76;
  const els = lines
    .map(
      (l, i) =>
        `<text x="${x}" y="${(firstBase + i * lineH).toFixed(1)}" font-family="Inter" font-size="${size}" font-weight="${weight}" letter-spacing="${ls.toFixed(2)}" fill="url(#titleFill)">${esc(l)}</text>`,
    )
    .join("\n      ");
  return { els, size, blockTop: top, blockBottom: firstBase + (lines.length - 1) * lineH + size * 0.22 };
}

function kickerEl(text, x, y) {
  return `<text x="${x}" y="${y}" font-family="Inter" font-size="25" font-weight="600" letter-spacing="7.6" fill="${KICK_COL}">${esc(text)}</text>`;
}

const dataUri = (file) => "data:image/jpeg;base64," + fs.readFileSync(file).toString("base64");

/* ------------------------------------------------------------- option one */

// Photo panel on the right, type on the left over a light-black field.
function splitPanel(d) {
  const px0 = Math.round(W * 0.505);
  const pw = W - px0;
  const textX = PAD;
  const maxW = px0 - PAD - 90;
  const { els, blockTop, blockBottom } = titleBlock(d.lines, textX, H / 2 + 26, maxW);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>${esc(d.lines.join(" "))} — Split Panel</title>
  <defs>
    <filter id="grade" color-interpolation-filters="sRGB">
      <feColorMatrix type="saturate" values="0.78"/>
      <feComponentTransfer><feFuncR type="linear" slope="0.94"/><feFuncG type="linear" slope="0.94"/><feFuncB type="linear" slope="0.96"/></feComponentTransfer>
    </filter>
    <linearGradient id="feather" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${INK}" stop-opacity="1"/>
      <stop offset="0.55" stop-color="${INK}" stop-opacity="0.72"/>
      <stop offset="1" stop-color="${INK}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="panelShade" x1="0" y1="0" x2="1" y2="0.4">
      <stop offset="0" stop-color="rgba(6,7,10,0)"/>
      <stop offset="1" stop-color="rgba(6,7,10,0.5)"/>
    </linearGradient>
    <linearGradient id="titleFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#D7DCE6"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${INK}"/>
  <image href="${dataUri(d.photo)}" x="${px0}" y="0" width="${pw}" height="${H}" preserveAspectRatio="xMidYMid slice" filter="url(#grade)"/>
  <rect x="${px0}" y="0" width="${pw}" height="${H}" fill="url(#panelShade)"/>
  <rect x="${px0 - 240}" y="0" width="240" height="${H}" fill="url(#feather)"/>
  <rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>
  <g>
      ${kickerEl(d.kicker, textX, blockTop - 46)}
      ${els}
      <rect x="${textX}" y="${(blockBottom + 40).toFixed(1)}" width="64" height="3" fill="${ACCENT}"/>
      <text x="${(textX + 84).toFixed(1)}" y="${(blockBottom + 50).toFixed(1)}" font-family="Inter" font-size="24" font-weight="600" letter-spacing="4" fill="rgba(255,255,255,0.34)">${esc(d.index)}</text>
  </g>
</svg>
`;
}

/* ----------------------------------------------------------- option three */

// Photo full-bleed, graded to a single monochrome tone, type laid over it.
function duotoneBleed(d) {
  const textX = PAD;
  const maxW = W - PAD * 2;
  const bottom = H - PAD;
  const { els, blockTop } = titleBlock(d.lines, textX, bottom - 120, maxW);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>${esc(d.lines.join(" "))} — Duotone Bleed</title>
  <defs>
    <filter id="duo" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="0.166 0.558 0.056 0 0.010  0.170 0.572 0.058 0 0.011  0.184 0.620 0.062 0 0.014  0 0 0 1 0"/>
    </filter>
    <linearGradient id="scrim" x1="0" y1="0.15" x2="0.65" y2="1">
      <stop offset="0" stop-color="rgba(6,7,10,0.15)"/>
      <stop offset="0.55" stop-color="rgba(6,7,10,0.55)"/>
      <stop offset="1" stop-color="rgba(4,5,8,0.94)"/>
    </linearGradient>
    <radialGradient id="vig" cx="0.42" cy="0.42" r="0.9">
      <stop offset="0.45" stop-color="rgba(0,0,0,0)"/>
      <stop offset="1" stop-color="rgba(0,0,0,0.6)"/>
    </radialGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.5" intercept="-0.25"/></feComponentTransfer></filter>
    <linearGradient id="titleFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#E4E8F0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${INK}"/>
  <image href="${dataUri(d.photo)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" filter="url(#duo)"/>
  <rect width="${W}" height="${H}" fill="url(#scrim)"/>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.22"/>
  <rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>
  <g>
      ${kickerEl(d.kicker, textX, blockTop - 46)}
      ${els}
      <rect x="${textX}" y="${(bottom - 46).toFixed(1)}" width="64" height="3" fill="${ACCENT}"/>
      <text x="${(textX + 84).toFixed(1)}" y="${(bottom - 36).toFixed(1)}" font-family="Inter" font-size="24" font-weight="600" letter-spacing="4" fill="rgba(255,255,255,0.4)">${esc(d.index)}</text>
  </g>
</svg>
`;
}

/* ------------------------------------------------------------------- demo */

const DEMO = [
  { key: "spotlight-top-10", lines: ["Spotlight", "Top 10"], kicker: "MOVIES · EDITORIAL", index: "01", photo: "spotlight.jpg" },
  { key: "genres", lines: ["Genres"], kicker: "BROWSE", index: "02", photo: "genres.jpg" },
  { key: "global-ott-top-10", lines: ["Global OTT", "Top 10"], kicker: "STREAMING", index: "03", photo: "ott.jpg" },
];

const OPTIONS = [
  { dir: "option-1", n: 1, name: "Split Panel", blurb: "Real photo beside the text. Light-black field, type left, image right.", build: splitPanel },
  { dir: "option-3", n: 3, name: "Duotone Bleed", blurb: "Real photo full-bleed, graded to one monochrome tone, type over it.", build: duotoneBleed },
];

function render() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const d of DEMO) d.photo = path.join(PHOTOS, d.photo);

  for (const opt of OPTIONS) {
    const dir = path.join(OUT, opt.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const d of DEMO) {
      const svg = opt.build(d);
      fs.writeFileSync(path.join(dir, `${d.key}.svg`), svg);
      const resvg = new Resvg(svg, {
        fitTo: { mode: "original" },
        shapeRendering: 2,
        textRendering: 2,
        font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter", sansSerifFamily: "Inter" },
      });
      fs.writeFileSync(path.join(dir, `${d.key}.png`), resvg.render().asPng());
      console.log(`  ${opt.dir}/${d.key}`);
    }
  }

  writeGallery();
  console.log("Wrote covers/_options/index.html");
}

function writeGallery() {
  const cols = DEMO.map((d) => {
    const cards = OPTIONS.map(
      (o) => `        <figure class="card">
          <img src="./${o.dir}/${d.key}.png" alt="${esc(d.lines.join(" "))} — ${o.name}">
        </figure>`,
    ).join("\n");
    return `      <section>
        <header><h2>${esc(d.lines.join(" "))}</h2><code>${d.key}</code></header>
        <div class="pair">
          <div class="lab"><span>Option 1</span> Split Panel</div>
          <div class="lab"><span>Option 3</span> Duotone Bleed</div>
        </div>
        <div class="grid">
${cards}
        </div>
      </section>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoCAT — imagery options 1 &amp; 3</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; } * { box-sizing: border-box; }
  body { margin:0; padding:56px 40px 100px; background:#08090C; color:#E8EAF2; font-family:Inter,system-ui,sans-serif; }
  .head { max-width:1280px; margin:0 auto 20px; }
  .head h1 { font-size:40px; font-weight:800; letter-spacing:-.03em; margin:0 0 8px; }
  .head p { margin:0; color:rgba(255,255,255,.55); font-size:16px; max-width:760px; }
  .legend { max-width:1280px; margin:28px auto 56px; display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .legend div { border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:16px 18px; background:#0D0E12; }
  .legend b { display:block; font-size:13px; letter-spacing:.14em; text-transform:uppercase; color:#C8A96A; margin-bottom:6px; }
  .legend span { color:rgba(255,255,255,.6); font-size:14px; }
  main { max-width:1280px; margin:0 auto; display:flex; flex-direction:column; gap:56px; }
  section header { display:flex; align-items:baseline; gap:14px; margin-bottom:12px; }
  section h2 { font-size:20px; font-weight:700; margin:0; letter-spacing:-.015em; }
  section code { margin-left:auto; font-size:12px; color:rgba(255,255,255,.3); }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:8px; }
  .lab { font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:rgba(255,255,255,.45); font-weight:600; }
  .lab span { color:#fff; background:rgba(200,169,106,.16); border:1px solid rgba(200,169,106,.4); padding:2px 8px; border-radius:999px; margin-right:8px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
  .card { margin:0; }
  .card img { display:block; width:100%; border-radius:14px; border:1px solid rgba(255,255,255,.08); }
</style></head><body>
  <div class="head">
    <h1>Cover imagery — Option 1 vs Option 3</h1>
    <p>The same three collections and the same real photographs, rendered through two treatments, so you can compare them directly. Both keep the light-black field and the same Inter typography.</p>
  </div>
  <div class="legend">
    <div><b>Option 1 — Split Panel</b><span>Photograph sits beside the text in an edge-to-edge right panel; the title owns the left. Calm, editorial, very legible at small sizes.</span></div>
    <div><b>Option 3 — Duotone Bleed</b><span>Photograph fills the frame, graded to a single monochrome tone with grain and a scrim; the title sits over it. Moodier, more cinematic, less uniform across a long list.</span></div>
  </div>
  <main>
${cols}
  </main>
</body></html>
`;
  fs.writeFileSync(path.join(OUT, "index.html"), html);
}

render();
