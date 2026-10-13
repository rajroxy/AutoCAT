#!/usr/bin/env node
/**
 * Imagery-source comparison.
 *
 * Same three collections, same layout, same typography — only the artwork source
 * changes, so the comparison is fair:
 *
 *   Option 1 — Auto-fetched image : a real, topic-matched photograph pulled from
 *                                   Wikimedia Commons for each collection.
 *   Option 2 — Vector scene       : artwork drawn procedurally in SVG, no photos.
 *   Option 3 — Hybrid             : a vector scene as the backdrop with a real
 *                                   fetched photo inset into it.
 *
 * Output: covers/_options/option-1|2|3/*.png + covers/_options/index.html
 *
 * Run with:  node preview-imagery.mjs
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
const PANEL_X = Math.round(W * 0.505);
const PANEL_W = W - PANEL_X;

const INK = "#08090C";
const ACCENT = "#C8A96A";

/* ------------------------------------------------------------------ fonts */

const FONT_FILES = [
  { weight: 500, file: "Inter-Medium.ttf" },
  { weight: 600, file: "Inter-SemiBold.ttf" },
  { weight: 700, file: "Inter-Bold.ttf" },
  { weight: 800, file: "Inter-ExtraBold.ttf" },
  { weight: 900, file: "Inter-Black.ttf" },
];
const fontFiles = FONT_FILES.map((f) => path.join(FONT_DIR, f.file));
const loaded = FONT_FILES.map((f) => {
  const buf = fs.readFileSync(path.join(FONT_DIR, f.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { weight: f.weight, font: opentype.parse(ab) };
});
function pickFont(w) {
  let best = loaded[0];
  for (const f of loaded) if (Math.abs(f.weight - w) < Math.abs(best.weight - w)) best = f;
  return best.font;
}
function measure(text, size, weight, ls = 0) {
  const font = pickFont(weight);
  let u = 0;
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    u += g && g.advanceWidth ? g.advanceWidth : font.unitsPerEm * 0.52;
  }
  return (u * size) / font.unitsPerEm + ls * text.length;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function titleSize(lines, maxW) {
  let size = lines.length === 1 ? 250 : 186;
  for (;;) {
    const ls = -0.035 * size;
    if (Math.max(...lines.map((l) => measure(l, size, 800, ls))) <= maxW || size <= 40) break;
    size -= 2;
  }
  return size;
}

/* --------------------------------------------------------------- auto fetch */

const UA = "AutoCATCoverPreview/1.0 (cover art generator)";

// Openverse: keyless, aggregated, and relevance-ranked — so the fetched image
// is genuinely about the collection rather than the first full-text hit.
async function fetchPhoto(key, query) {
  const dest = path.join(PHOTOS, `${key}.jpg`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 8192) return dest;
  fs.mkdirSync(PHOTOS, { recursive: true });
  const api =
    "https://api.openverse.org/v1/images/?" +
    `q=${encodeURIComponent(query)}&page_size=12&mature=false&license_type=commercial`;
  const res = await fetch(api, { headers: { "user-agent": UA } });
  const json = await res.json();
  const results = json?.results ?? [];
  const hit = results.find((r) => /\.(jpe?g|png|webp)$/i.test(String(r?.url ?? "").split("?")[0]));
  if (!hit) throw new Error(`no image for "${query}"`);
  const img = await fetch(hit.url, { headers: { "user-agent": UA } });
  const buf = Buffer.from(await img.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(
    `  fetched ${key}.jpg  ${(buf.length / 1024).toFixed(0)}kB  "${hit.title}" (${hit.source}, ${hit.license})`,
  );
  return dest;
}

/* ----------------------------------------------------------- vector scenes */

// Each scene draws inside the panel box and returns SVG markup. Thin strokes,
// soft glows, restrained palette — no clip-art, no icons.
function sceneBeams(x, y, w, h) {
  const apexX = x + w * 0.5;
  const apexY = y - h * 0.12;
  const beams = [-0.62, -0.32, 0, 0.32, 0.62].map((t, i) => {
    const bx = x + w * (0.5 + t);
    const op = i === 2 ? 0.5 : 0.22;
    return `<polygon points="${apexX},${apexY} ${bx - w * 0.075},${y + h} ${bx + w * 0.075},${y + h}" fill="url(#beamG)" opacity="${op}"/>`;
  }).join("\n    ");
  const horizon = y + h * 0.72;
  return `
    <circle cx="${apexX}" cy="${apexY}" r="${h * 0.42}" fill="url(#glow)"/>
    ${beams}
    <circle cx="${x + w * 0.5}" cy="${horizon}" r="${h * 0.135}" fill="none" stroke="url(#ivoryS)" stroke-width="2"/>
    <circle cx="${x + w * 0.5}" cy="${horizon}" r="${h * 0.135}" fill="url(#disc)"/>
    <line x1="${x}" y1="${horizon}" x2="${x + w}" y2="${horizon}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.55"/>`;
}

function sceneBars(x, y, w, h) {
  const n = 11;
  const gap = w / (n + 1);
  const mid = y + h * 0.56;
  const bars = Array.from({ length: n }, (_, i) => {
    const bx = x + gap * (i + 1);
    const t = Math.sin((i / (n - 1)) * Math.PI);
    const bh = h * (0.16 + t * 0.42);
    const bw = gap * 0.42;
    return `<rect x="${(bx - bw / 2).toFixed(0)}" y="${(mid - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" rx="${(bw / 2).toFixed(0)}" fill="url(#barG)" opacity="0.9"/>`;
  }).join("\n    ");
  return `
    <circle cx="${x + w * 0.5}" cy="${mid - h * 0.02}" r="${h * 0.3}" fill="url(#glow)"/>
    ${bars}
    <line x1="${x + gap * 0.5}" y1="${mid}" x2="${x + w - gap * 0.5}" y2="${mid}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.5"/>
    <circle cx="${x + w * 0.5}" cy="${mid - h * 0.02}" r="${h * 0.30}" fill="none" stroke="url(#ivoryS)" stroke-width="2"/>`;
}

function sceneGlobe(x, y, w, h) {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const r = h * 0.30;
  const meridians = [0.35, 0.68, 1].map(
    (k) => `<ellipse cx="${cx}" cy="${cy}" rx="${(r * k).toFixed(0)}" ry="${r.toFixed(0)}" fill="none" stroke="url(#ivoryS)" stroke-width="2" opacity="0.7"/>`,
  ).join("\n    ");
  const parallels = [-0.55, 0, 0.55].map(
    (k) => `<ellipse cx="${cx}" cy="${(cy + r * k).toFixed(0)}" rx="${(r * Math.sqrt(1 - k * k)).toFixed(0)}" ry="${(r * 0.16).toFixed(0)}" fill="none" stroke="url(#ivoryS)" stroke-width="2" opacity="0.5"/>`,
  ).join("\n    ");
  const dots = [
    [-0.42, -0.24], [0.18, -0.42], [0.45, 0.1], [-0.1, 0.36], [-0.5, 0.3], [0.05, -0.05],
  ].map(
    ([dx, dy]) => `<circle cx="${(cx + r * dx).toFixed(0)}" cy="${(cy + r * dy).toFixed(0)}" r="5" fill="${ACCENT}" opacity="0.9"/>`,
  ).join("\n    ");
  return `
    <circle cx="${cx}" cy="${cy}" r="${(r * 1.5).toFixed(0)}" fill="url(#glow)"/>
    <circle cx="${cx}" cy="${cy}" r="${r.toFixed(0)}" fill="none" stroke="url(#ivoryS)" stroke-width="2.4"/>
    ${meridians}
    ${parallels}
    <circle cx="${cx}" cy="${cy}" r="${(r * 0.99).toFixed(0)}" fill="url(#sphere)"/>
    ${dots}`;
}

const SCENES = { beams: sceneBeams, bars: sceneBars, globe: sceneGlobe };

function sceneDefs() {
  return `
    <linearGradient id="ivoryS" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#9AA2B4"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="${ACCENT}" stop-opacity="0.06"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="beamG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="barG" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#3A3F4D"/>
      <stop offset="0.6" stop-color="#C9CEDB"/>
      <stop offset="1" stop-color="#FFFFFF"/>
    </linearGradient>
    <radialGradient id="disc" cx="0.38" cy="0.34" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0.12"/>
    </radialGradient>
    <radialGradient id="sphere" cx="0.36" cy="0.32" r="0.8">
      <stop offset="0" stop-color="#8E9AB0" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#08090C" stop-opacity="0.55"/>
    </radialGradient>`;
}

/* ---------------------------------------------------------------- compose */

function textLayer(d) {
  const maxW = PANEL_X - PAD - 90;
  const size = titleSize(d.lines, maxW);
  const ls = -0.035 * size;
  const lineH = size * 0.96;
  const blockH = (d.lines.length - 1) * lineH + size;
  const top = H / 2 + 26 - blockH / 2;
  const firstBase = top + size * 0.76;
  const els = d.lines
    .map(
      (l, i) =>
        `<text x="${PAD}" y="${(firstBase + i * lineH).toFixed(1)}" font-family="Inter" font-size="${size}" font-weight="800" letter-spacing="${ls.toFixed(2)}" fill="url(#titleFill)">${esc(l)}</text>`,
    )
    .join("\n      ");
  const bottom = firstBase + (d.lines.length - 1) * lineH + size * 0.22;
  return `<text x="${PAD}" y="${(top - 46).toFixed(1)}" font-family="Inter" font-size="25" font-weight="600" letter-spacing="7.6" fill="rgba(255,255,255,0.55)">${esc(d.kicker)}</text>
      ${els}
      <rect x="${PAD}" y="${(bottom + 40).toFixed(1)}" width="64" height="3" fill="${ACCENT}"/>
      <text x="${PAD + 84}" y="${(bottom + 50).toFixed(1)}" font-family="Inter" font-size="24" font-weight="600" letter-spacing="4" fill="rgba(255,255,255,0.34)">${esc(d.index)}</text>`;
}

const baseDefs = `
    <linearGradient id="titleFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D7DCE6"/>
    </linearGradient>
    <linearGradient id="feather" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${INK}" stop-opacity="1"/>
      <stop offset="0.6" stop-color="${INK}" stop-opacity="0.6"/>
      <stop offset="1" stop-color="${INK}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="panelShade" x1="0" y1="0" x2="1" y2="0.5">
      <stop offset="0" stop-color="rgba(6,7,10,0)"/><stop offset="1" stop-color="rgba(6,7,10,0.45)"/>
    </linearGradient>
    <filter id="grade" color-interpolation-filters="sRGB">
      <feColorMatrix type="saturate" values="0.82"/>
      <feComponentTransfer><feFuncR type="linear" slope="0.95"/><feFuncG type="linear" slope="0.95"/><feFuncB type="linear" slope="0.97"/></feComponentTransfer>
    </filter>`;

function frame(inner, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>${esc(title)}</title>
  <defs>${baseDefs}${sceneDefs()}</defs>
  <rect width="${W}" height="${H}" fill="${INK}"/>
  <g>
${inner}
  </g>
  <rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>
  <g>
      ${textLayer({ ...current, lines: current.lines })}
  </g>
</svg>
`;
}

/* --------------------------------------------------------------- options */

function option1(d) {
  const inner = `<image href="${dataUri(d.photo)}" x="${PANEL_X}" y="0" width="${PANEL_W}" height="${H}" preserveAspectRatio="xMidYMid slice" filter="url(#grade)"/>
  <rect x="${PANEL_X}" y="0" width="${PANEL_W}" height="${H}" fill="url(#panelShade)"/>
  <rect x="${PANEL_X - 240}" y="0" width="240" height="${H}" fill="url(#feather)"/>`;
  return frame(inner, `${d.lines.join(" ")} — Auto-fetched image`);
}

function option2(d) {
  const inner = `<rect x="${PANEL_X}" y="0" width="${PANEL_W}" height="${H}" fill="#0B0C10"/>
  <g opacity="0.98">${d.scene(PANEL_X, 0, PANEL_W, H)}</g>
  <rect x="${PANEL_X}" y="0" width="${PANEL_W}" height="${H}" fill="url(#panelShade)"/>
  <rect x="${PANEL_X - 240}" y="0" width="240" height="${H}" fill="url(#feather)"/>`;
  return frame(inner, `${d.lines.join(" ")} — Vector scene`);
}

function option3(d) {
  const inset = { x: PANEL_X + 96, y: 150, w: PANEL_W - 192, h: 480, r: 20 };
  const inner = `<rect x="${PANEL_X}" y="0" width="${PANEL_W}" height="${H}" fill="#0B0C10"/>
  <g opacity="0.98">${d.scene(PANEL_X, 0, PANEL_W, H)}</g>
  <defs><clipPath id="insetClip"><rect x="${inset.x}" y="${inset.y}" width="${inset.w}" height="${inset.h}" rx="${inset.r}"/></clipPath></defs>
  <g clip-path="url(#insetClip)">
    <image href="${dataUri(d.photo)}" x="${inset.x}" y="${inset.y}" width="${inset.w}" height="${inset.h}" preserveAspectRatio="xMidYMid slice" filter="url(#grade)"/>
  </g>
  <rect x="${inset.x}" y="${inset.y}" width="${inset.w}" height="${inset.h}" rx="${inset.r}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
  <rect x="${PANEL_X}" y="0" width="${PANEL_W}" height="${H}" fill="url(#panelShade)"/>
  <rect x="${PANEL_X - 240}" y="0" width="240" height="${H}" fill="url(#feather)"/>`;
  return frame(inner, `${d.lines.join(" ")} — Hybrid`);
}

const dataUri = (file) => "data:image/jpeg;base64," + fs.readFileSync(file).toString("base64");

/* ------------------------------------------------------------------- demo */

const DEMO = [
  { key: "spotlight-top-10", lines: ["Spotlight", "Top 10"], kicker: "MOVIES · EDITORIAL", index: "01", scene: SCENES.beams, query: "concert stage spotlight crowd" },
  { key: "genres", lines: ["Genres"], kicker: "BROWSE", index: "02", scene: SCENES.bars, query: "cinema film reel projector" },
  { key: "global-ott-top-10", lines: ["Global OTT", "Top 10"], kicker: "STREAMING", index: "03", scene: SCENES.globe, query: "world map globe earth" },
];

const OPTIONS = [
  { dir: "option-1", n: 1, name: "Auto-fetched image", blurb: "A real, topic-matched photograph is fetched per collection and sits beside the text.", build: option1 },
  { dir: "option-2", n: 2, name: "Vector scene", blurb: "Artwork drawn procedurally in SVG — no photographs, infinitely crisp, perfectly consistent.", build: option2 },
  { dir: "option-3", n: 3, name: "Hybrid", blurb: "A vector scene as the backdrop with a real fetched photo inset into it.", build: option3 },
];

let current;

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("Auto-fetching topic-matched photos (Openverse):");
  for (const d of DEMO) {
    try {
      d.photo = await fetchPhoto(d.key, d.query);
    } catch (e) {
      console.warn(`  ! ${d.key}: ${e.message} — falling back to seeded photo`);
      d.photo = await fetchPhoto(d.key, d.lines.join(" "));
    }
  }

  for (const opt of OPTIONS) {
    const dir = path.join(OUT, opt.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const d of DEMO) {
      current = d;
      const svg = opt.build(d);
      fs.writeFileSync(path.join(dir, `${d.key}.svg`), svg);
      const resvg = new Resvg(svg, {
        fitTo: { mode: "original" },
        shapeRendering: 2,
        textRendering: 2,
        font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter", sansSerifFamily: "Inter" },
      });
      fs.writeFileSync(path.join(dir, `${d.key}.png`), resvg.render().asPng());
      console.log(`  rendered ${opt.dir}/${d.key}`);
    }
  }

  fs.writeFileSync(path.join(OUT, "index.html"), gallery());
  console.log("Wrote covers/_options/index.html");
}

function gallery() {
  const sections = DEMO.map((d) => {
    const cards = OPTIONS.map(
      (o) => `<figure class="card"><img src="./${o.dir}/${d.key}.png" alt="${esc(d.lines.join(" "))} — ${o.name}"></figure>`,
    ).join("\n          ");
    const labels = OPTIONS.map((o) => `<div class="lab"><span>${o.n}</span>${o.name}</div>`).join("");
    return `<section>
        <header><h2>${esc(d.lines.join(" "))}</h2><code>${d.key}</code></header>
        <div class="pair three">${labels}</div>
        <div class="grid three">
          ${cards}
        </div>
      </section>`;
  }).join("\n");

  const legend = OPTIONS.map(
    (o) => `<div><b>Option ${o.n} — ${o.name}</b><span>${o.blurb}</span></div>`,
  ).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoCAT — imagery sources</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; } * { box-sizing: border-box; }
  body { margin:0; padding:56px 40px 100px; background:#08090C; color:#E8EAF2; font-family:Inter,system-ui,sans-serif; }
  .head { max-width:1360px; margin:0 auto 20px; }
  .head h1 { font-size:40px; font-weight:800; letter-spacing:-.03em; margin:0 0 8px; }
  .head p { margin:0; color:rgba(255,255,255,.55); font-size:16px; max-width:820px; }
  .legend { max-width:1360px; margin:28px auto 56px; display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
  .legend div { border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:16px 18px; background:#0D0E12; }
  .legend b { display:block; font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:#C8A96A; margin-bottom:6px; }
  .legend span { color:rgba(255,255,255,.6); font-size:14px; }
  main { max-width:1360px; margin:0 auto; display:flex; flex-direction:column; gap:56px; }
  section header { display:flex; align-items:baseline; gap:14px; margin-bottom:12px; }
  section h2 { font-size:20px; font-weight:700; margin:0; letter-spacing:-.015em; }
  section code { margin-left:auto; font-size:12px; color:rgba(255,255,255,.3); }
  .pair { display:grid; gap:20px; margin-bottom:8px; }
  .pair.three, .grid.three { grid-template-columns:repeat(3,1fr); }
  .lab { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:rgba(255,255,255,.45); font-weight:600; }
  .lab span { color:#fff; background:rgba(200,169,106,.16); border:1px solid rgba(200,169,106,.4); padding:2px 8px; border-radius:999px; margin-right:8px; }
  .grid { display:grid; gap:20px; }
  .card { margin:0; }
  .card img { display:block; width:100%; border-radius:14px; border:1px solid rgba(255,255,255,.08); }
</style></head><body>
  <div class="head">
    <h1>Cover imagery — Option 1, 2 &amp; 3</h1>
    <p>Identical layout, identical Inter typography, identical light-black field. Only the artwork source changes — so you can compare like for like.</p>
  </div>
  <div class="legend">${legend}</div>
  <main>
${sections}
  </main>
</body></html>
`;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
