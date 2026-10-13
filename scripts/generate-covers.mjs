#!/usr/bin/env node
/**
 * AutoCAT collection cover generator.
 *
 * Produces landscape (16:9) collection covers as:
 *   - animated SVG  (vector master, crisp at any size)
 *   - PNG 1920x1080 (rendered with the real Inter font, drop-in for apps)
 *
 * Art direction: a near-black field, the collection title set large in Inter on
 * the left, and a procedural vector scene in a panel on the right. No
 * photographs, no hue rotation, no colour-field drift — the scene is drawn in
 * code, so it is perfectly consistent across every cover and infinitely crisp.
 *
 * Every collection is emitted twice: a "movies" row version and a "shows" row
 * version. Both share the composition and palette; the shows scene is mirrored
 * so the two rows stay related but distinct without shifting hue.
 *
 * Run with:  node generate-covers.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { COLLECTIONS, title as collectionTitle, catalogLabels, subtitleOf } from "./collections.mjs";

const require = createRequire(import.meta.url);
const opentype = require("opentype.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FONT_DIR = path.join(__dirname, "fonts");
const OUT_DIR = path.join(ROOT, "covers");

const W = 1920;
const H = 1080;
const PAD = 140;

// The scene lives in an inset, rounded inner card on the right. The title is
// confined to the left column so it can never grow across into the card.
const PANEL_X = Math.round(W * 0.505);
const CARD_X = PANEL_X;
const CARD_Y = 60;
const CARD_W = W - CARD_X - 60;
const CARD_H = H - CARD_Y * 2;
const CARD_R = 30;
const CARD_CX = CARD_X + CARD_W / 2;
const TEXT_RIGHT = CARD_X - 70; // title column ends here

const INK = "#08090C";
const PANEL_BG = "#0B0C10";
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

const loadedFonts = FONT_FILES.map((f) => {
  const buf = fs.readFileSync(path.join(FONT_DIR, f.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { weight: f.weight, font: opentype.parse(ab) };
});

function pickFont(weight) {
  let best = loadedFonts[0];
  for (const f of loadedFonts) {
    if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f;
  }
  return best.font;
}

/** Advance-width measurement, summed per glyph (skips GSUB for robustness). */
function measure(text, size, weight, letterSpacing = 0) {
  const font = pickFont(weight);
  let units = 0;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    const adv = glyph && glyph.advanceWidth ? glyph.advanceWidth : font.unitsPerEm * 0.52;
    units += adv;
  }
  return (units * size) / font.unitsPerEm + letterSpacing * text.length;
}

/* -------------------------------------------------------------- utilities */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (v) => (Math.round(v * 10) / 10).toString();

/* ------------------------------------------------------------------ scenes */

// Every scene draws inside the right-hand panel. Shared visual language: hairline
// ivory strokes, a soft champagne glow, restrained fills — nothing clip-art.

/** A four-point spark — used for "fresh" markers. */
function star(cx, cy, R, r) {
  const c = (v) => n(v);
  return `M ${c(cx)} ${c(cy - R)} L ${c(cx + r)} ${c(cy - r)} L ${c(cx + R)} ${c(cy)} L ${c(cx + r)} ${c(cy + r)} L ${c(cx)} ${c(cy + R)} L ${c(cx - r)} ${c(cy + r)} L ${c(cx - R)} ${c(cy)} L ${c(cx - r)} ${c(cy - r)} Z`;
}

function sinePath(cx, cy, amp, span, cycles, phase, steps = 96) {
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = cx - span / 2 + span * t;
    const py = cy + Math.sin(t * Math.PI * 2 * cycles + phase) * amp;
    d += `${i === 0 ? "M" : "L"} ${n(px)} ${n(py)} `;
  }
  return d.trim();
}

const scenes = {};

/* 01 — Spotlight Top 10: stage beams over a horizon disc. */
scenes["spotlight-top-10"] = (x, y, w, h) => {
  const cx = x + w / 2;
  const apexY = y - h * 0.12;
  const beams = [-0.62, -0.32, 0, 0.32, 0.62]
    .map((t, i) => {
      const bx = x + w * (0.5 + t);
      const op = i === 2 ? 0.46 : 0.2;
      return `<polygon points="${n(cx)},${n(apexY)} ${n(bx - w * 0.075)},${n(y + h)} ${n(bx + w * 0.075)},${n(y + h)}" fill="url(#beamG)" opacity="${op}"/>`;
    })
    .join("\n    ");
  const hz = y + h * 0.72;
  return `<circle cx="${n(cx)}" cy="${n(apexY)}" r="${n(h * 0.42)}" fill="url(#glow)"/>
    ${beams}
    <circle cx="${n(cx)}" cy="${n(hz)}" r="${n(h * 0.135)}" fill="url(#disc)"/>
    <circle cx="${n(cx)}" cy="${n(hz)}" r="${n(h * 0.135)}" fill="none" stroke="url(#ivoryS)" stroke-width="2"/>
    <line x1="${n(x)}" y1="${n(hz)}" x2="${n(x + w)}" y2="${n(hz)}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.5"/>`;
};

/* 02 — Discover: a radar sweep with range rings and bearing ticks. */
scenes["discover"] = (x, y, w, h) => {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const R = h * 0.33;
  const rings = [0.38, 0.66, 1]
    .map((k) => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * k)}" fill="none" stroke="url(#ivoryS)" stroke-width="2" opacity="0.55"/>`)
    .join("\n    ");
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    return `<line x1="${n(cx + R * 0.84 * Math.cos(a))}" y1="${n(cy + R * 0.84 * Math.sin(a))}" x2="${n(cx + R * Math.cos(a))}" y2="${n(cy + R * Math.sin(a))}" stroke="url(#ivoryS)" stroke-width="3" opacity="0.45"/>`;
  }).join("\n    ");
  const a0 = -1.05;
  const a1 = 0.1;
  const sweep = `<path d="M ${n(cx)} ${n(cy)} L ${n(cx + R * Math.cos(a0))} ${n(cy + R * Math.sin(a0))} A ${n(R)} ${n(R)} 0 0 1 ${n(cx + R * Math.cos(a1))} ${n(cy + R * Math.sin(a1))} Z" fill="url(#beamG)" opacity="0.4"/>`;
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * 1.5)}" fill="url(#glow)"/>
    ${rings}
    ${ticks}
    ${sweep}
    <circle cx="${n(cx)}" cy="${n(cy)}" r="7" fill="${ACCENT}"/>`;
};

/* 03 — Popular by Genre: vertical columns of unequal rank. */
scenes["popular-by-genre"] = (x, y, w, h) => {
  const pattern = [0.42, 0.64, 0.34, 0.8, 0.52, 0.92, 0.46, 0.7, 0.3];
  const gap = (w * 0.78) / pattern.length;
  const x0 = x + w * 0.11;
  const base = y + h * 0.74;
  const cols = pattern
    .map((p, i) => {
      const bw = gap * 0.46;
      const bh = h * p;
      const bx = x0 + gap * (i + 0.5) - bw / 2;
      return `<rect x="${n(bx)}" y="${n(base - bh)}" width="${n(bw)}" height="${n(bh)}" rx="${n(bw / 2)}" fill="url(#colG)"/>`;
    })
    .join("\n    ");
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(base - h * 0.3)}" r="${n(h * 0.55)}" fill="url(#glow)"/>
    ${cols}
    <line x1="${n(x0 - gap * 0.3)}" y1="${n(base)}" x2="${n(x0 + gap * pattern.length + gap * 0.1)}" y2="${n(base)}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.5"/>`;
};

/* 04 — Genres: a symmetric spectrum of bars around a ring. */
scenes["genres"] = (x, y, w, h) => {
  const N = 11;
  const gap = w / (N + 1);
  const mid = y + h * 0.56;
  const bars = Array.from({ length: N }, (_, i) => {
    const bx = x + gap * (i + 1);
    const t = Math.sin((i / (N - 1)) * Math.PI);
    const bh = h * (0.16 + t * 0.42);
    const bw = gap * 0.42;
    return `<rect x="${n(bx - bw / 2)}" y="${n(mid - bh)}" width="${n(bw)}" height="${n(bh)}" rx="${n(bw / 2)}" fill="url(#barG)" opacity="0.92"/>`;
  }).join("\n    ");
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(mid - h * 0.02)}" r="${n(h * 0.3)}" fill="url(#glow)"/>
    ${bars}
    <circle cx="${n(x + w * 0.5)}" cy="${n(mid - h * 0.02)}" r="${n(h * 0.3)}" fill="none" stroke="url(#ivoryS)" stroke-width="2"/>
    <line x1="${n(x + gap * 0.5)}" y1="${n(mid)}" x2="${n(x + w - gap * 0.5)}" y2="${n(mid)}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.45"/>`;
};

/* 05 — Popular by Decade: a rising trend across decade ticks. */
scenes["popular-by-decade"] = (x, y, w, h) => {
  const x0 = x + w * 0.12;
  const x1 = x + w * 0.88;
  const cy = y + h * 0.66;
  const N = 8;
  const vals = [0.28, 0.42, 0.36, 0.58, 0.52, 0.74, 0.68, 0.9];
  const step = (x1 - x0) / (N - 1);
  const pts = vals.map((v, i) => [x0 + step * i, cy - h * 0.46 * v]);
  const ticks = pts
    .map(([px]) => `<line x1="${n(px)}" y1="${n(cy)}" x2="${n(px)}" y2="${n(cy + 18)}" stroke="url(#ivoryS)" stroke-width="3" opacity="0.4"/>`)
    .join("\n    ");
  const line = `<polyline points="${pts.map(([px, py]) => `${n(px)},${n(py)}`).join(" ")}" fill="none" stroke="url(#ivoryS)" stroke-width="3" stroke-linejoin="round"/>`;
  const dots = pts
    .map(([px, py], i) => `<circle cx="${n(px)}" cy="${n(py)}" r="${i === N - 1 ? 8 : 5}" fill="${i === N - 1 ? ACCENT : "#E7EBF3"}"/>`)
    .join("\n    ");
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(cy - h * 0.22)}" r="${n(h * 0.5)}" fill="url(#glow)"/>
    <line x1="${n(x0)}" y1="${n(cy)}" x2="${n(x1)}" y2="${n(cy)}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.5"/>
    ${ticks}
    ${line}
    ${dots}`;
};

/* 06 — Decades: concentric rings with cardinal notches. */
scenes["decades"] = (x, y, w, h) => {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const Rs = [0.14, 0.23, 0.32, 0.4];
  const rings = Rs
    .map((k, i) => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(h * k)}" fill="none" stroke="url(#ivoryS)" stroke-width="${i === Rs.length - 1 ? 2.4 : 2}" opacity="${0.75 - i * 0.12}"/>`)
    .join("\n    ");
  const notches = [0, 0.25, 0.5, 0.75]
    .map((f) => {
      const a = f * Math.PI * 2 - Math.PI / 2;
      return `<line x1="${n(cx + h * 0.36 * Math.cos(a))}" y1="${n(cy + h * 0.36 * Math.sin(a))}" x2="${n(cx + h * 0.44 * Math.cos(a))}" y2="${n(cy + h * 0.44 * Math.sin(a))}" stroke="${ACCENT}" stroke-width="4" opacity="0.85"/>`;
    })
    .join("\n    ");
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(h * 0.62)}" fill="url(#glow)"/>
    ${rings}
    ${notches}
    <circle cx="${n(cx)}" cy="${n(cy)}" r="6" fill="#E7EBF3"/>`;
};

/* 07 — Genres in or from Decades: a grid with selected cells filled. */
scenes["genres-in-or-from-decades"] = (x, y, w, h, rand) => {
  const cols = 7;
  const rows = 5;
  const cw = w * 0.72;
  const ch = h * 0.6;
  const x0 = x + (w - cw) / 2;
  const y0 = y + (h - ch) / 2;
  const gw = cw / cols;
  const gh = ch / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const on = rand() > 0.62;
      const px = x0 + c * gw;
      const py = y0 + r * gh;
      cells.push(
        `<rect x="${n(px + gw * 0.12)}" y="${n(py + gh * 0.12)}" width="${n(gw * 0.76)}" height="${n(gh * 0.76)}" rx="6" fill="${on ? ACCENT : "rgba(255,255,255,0.08)"}" opacity="${on ? 0.85 : 1}"/>`,
      );
    }
  }
  return `<rect x="${n(x0 - 10)}" y="${n(y0 - 10)}" width="${n(cw + 20)}" height="${n(ch + 20)}" rx="16" fill="url(#glow)" opacity="0.6"/>
    ${cells.join("\n    ")}`;
};

/* 08 — Continental: layered contour lines. */
scenes["continental"] = (x, y, w, h) => {
  const lines = [];
  const rows = 8;
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const cy = y + h * (0.28 + t * 0.44);
    const amp = h * (0.03 + 0.06 * Math.sin(t * Math.PI));
    const phase = t * 2.2;
    lines.push(
      `<path d="${sinePath(x + w * 0.5, cy, amp, w * 0.74, 1.4, phase)}" fill="none" stroke="url(#ivoryS)" stroke-width="2" opacity="${0.7 - Math.abs(t - 0.5) * 0.7}"/>`,
    );
  }
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(y + h * 0.5)}" r="${n(h * 0.5)}" fill="url(#glow)"/>
    ${lines.join("\n    ")}`;
};

/* 09 — Countries: a dotted atlas with highlighted points. */
scenes["countries"] = (x, y, w, h, rand) => {
  const cols = 15;
  const rows = 9;
  const gw = (w * 0.74) / (cols - 1);
  const gh = (h * 0.56) / (rows - 1);
  const x0 = x + (w - (w * 0.74)) / 2;
  const y0 = y + (h - h * 0.56) / 2;
  const dots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hot = rand() > 0.93;
      dots.push(
        `<circle cx="${n(x0 + c * gw)}" cy="${n(y0 + r * gh)}" r="${hot ? 6 : 2.4}" fill="${hot ? ACCENT : "rgba(255,255,255,0.5)"}"/>`,
      );
    }
  }
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(y + h * 0.5)}" r="${n(h * 0.55)}" fill="url(#glow)"/>
    ${dots.join("\n    ")}`;
};

/* 10 — Runtimes: horizontal duration bars. */
scenes["runtimes"] = (x, y, w, h) => {
  const widths = [0.3, 0.46, 0.38, 0.7, 0.52, 0.88, 0.6];
  const x0 = x + w * 0.12;
    const rows = widths.length;
  const gap = (h * 0.56) / rows;
  const y0 = y + h * 0.22;
  const bars = widths
    .map((k, i) => `<rect x="${n(x0)}" y="${n(y0 + i * gap + gap * 0.14)}" width="${n(w * 0.72 * k)}" height="${n(gap * 0.44)}" rx="${n(gap * 0.22)}" fill="url(#colG)" opacity="${0.95 - i * 0.08}"/>`)
    .join("\n    ");
  return `<circle cx="${n(x + w * 0.45)}" cy="${n(y + h * 0.5)}" r="${n(h * 0.5)}" fill="url(#glow)"/>
    ${bars}`;
};

/* 11 — Based on the: stacked source pages. */
scenes["based-on-the"] = (x, y, w, h) => {
  const cards = [0, 1, 2];
  const cw = w * 0.5;
  const chh = h * 0.42;
  const els = cards
    .map((i) => {
      const px = x + w * 0.2 + i * w * 0.075;
      const py = y + h * 0.5 - chh / 2 - i * h * 0.045;
      const lines = [0, 1, 2]
        .map((k) => `<line x1="${n(px + cw * 0.14)}" y1="${n(py + chh * (0.42 + k * 0.16))}" x2="${n(px + cw * (0.72 - k * 0.12))}" y2="${n(py + chh * (0.42 + k * 0.16))}" stroke="rgba(255,255,255,${0.4 - k * 0.1})" stroke-width="3" stroke-linecap="round"/>`)
        .join("\n      ");
      return `<g>
      <rect x="${n(px)}" y="${n(py)}" width="${n(cw)}" height="${n(chh)}" rx="10" fill="${i === 2 ? "#15171E" : "#0F1116"}" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
      ${lines}
    </g>`;
    })
    .join("\n    ");
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(y + h * 0.5)}" r="${n(h * 0.5)}" fill="url(#glow)"/>
    ${els}
    <rect x="${n(x + w * 0.2 + 2 * w * 0.075)}" y="${n(y + h * 0.5 - chh / 2 - 2 * h * 0.045)}" width="${n(cw)}" height="4" rx="2" fill="${ACCENT}" opacity="0.85"/>`;
};

/* 12 — Moods & Vibes: layered waveforms. */
scenes["moods-and-vibes"] = (x, y, w, h) => {
  const cy = y + h * 0.5;
  const waves = [
    { amp: h * 0.18, cycles: 1.5, phase: 0, op: 0.85, w: 3 },
    { amp: h * 0.12, cycles: 2.5, phase: 1.2, op: 0.5, w: 2 },
    { amp: h * 0.08, cycles: 3.5, phase: 2.4, op: 0.3, w: 2 },
  ]
    .map((v) => `<path d="${sinePath(x + w * 0.5, cy, v.amp, w * 0.78, v.cycles, v.phase)}" fill="none" stroke="url(#ivoryS)" stroke-width="${v.w}" opacity="${v.op}"/>`)
    .join("\n    ");
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(cy)}" r="${n(h * 0.55)}" fill="url(#glow)"/>
    ${waves}`;
};

/* 13 — Themes & Tags: a scatter of tag pills. */
scenes["themes-and-tags"] = (x, y, w, h, rand) => {
  const rows = 5;
  const pills = [];
  for (let r = 0; r < rows; r++) {
    const py = y + h * (0.26 + r * 0.12);
    let px = x + w * (0.16 + rand() * 0.06);
    const count = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const pw = w * (0.12 + rand() * 0.16);
      const hot = rand() > 0.75;
      pills.push(
        `<rect x="${n(px)}" y="${n(py)}" width="${n(pw)}" height="${n(h * 0.075)}" rx="${n(h * 0.0375)}" fill="${hot ? "rgba(200,169,106,0.14)" : "none"}" stroke="${hot ? ACCENT : "rgba(255,255,255,0.28)"}" stroke-width="2"/>`,
      );
      px += pw + w * 0.04;
    }
  }
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(y + h * 0.5)}" r="${n(h * 0.55)}" fill="url(#glow)"/>
    ${pills.join("\n    ")}`;
};

/* 14 — Global OTT Top 10: a graticule sphere with plotted points. */
scenes["global-ott-top-10"] = (x, y, w, h) => {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const R = h * 0.3;
  const meridians = [0.35, 0.68, 1]
    .map((k) => `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(R * k)}" ry="${n(R)}" fill="none" stroke="url(#ivoryS)" stroke-width="2" opacity="0.65"/>`)
    .join("\n    ");
  const parallels = [-0.55, 0, 0.55]
    .map((k) => `<ellipse cx="${n(cx)}" cy="${n(cy + R * k)}" rx="${n(R * Math.sqrt(Math.max(0, 1 - k * k)))}" ry="${n(R * 0.16)}" fill="none" stroke="url(#ivoryS)" stroke-width="2" opacity="0.45"/>`)
    .join("\n    ");
  const dots = [
    [-0.42, -0.24],
    [0.18, -0.42],
    [0.45, 0.1],
    [-0.1, 0.36],
    [-0.5, 0.3],
    [0.05, -0.05],
  ]
    .map(([dx, dy]) => `<circle cx="${n(cx + R * dx)}" cy="${n(cy + R * dy)}" r="5" fill="${ACCENT}" opacity="0.9"/>`)
    .join("\n    ");
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * 1.5)}" fill="url(#glow)"/>
    <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="url(#disc)"/>
    <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="none" stroke="url(#ivoryS)" stroke-width="2.4"/>
    ${meridians}
    ${parallels}
    ${dots}`;
};

/* 15 — Global OTT: orbit rings with travelling points. */
scenes["global-ott"] = (x, y, w, h) => {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const Rings = [
    { k: 0.22, rot: -20 },
    { k: 0.32, rot: 14 },
    { k: 0.42, rot: -6 },
  ]
    .map((o) => `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(h * o.k * 1.35)}" ry="${n(h * o.k)}" transform="rotate(${o.rot} ${n(cx)} ${n(cy)})" fill="none" stroke="url(#ivoryS)" stroke-width="2" opacity="0.6"/>`)
    .join("\n    ");
  const pts = [
    [0.99, 0],
    [0.7, 0.72],
  ]
    .map(([dx, dy]) => `<circle cx="${n(cx + h * 0.42 * dx)}" cy="${n(cy + h * 0.31 * dy)}" r="6" fill="${ACCENT}"/>`)
    .join("\n    ");
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(h * 0.6)}" fill="url(#glow)"/>
    ${Rings}
    <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(h * 0.11)}" fill="url(#disc)" stroke="url(#ivoryS)" stroke-width="2"/>
    ${pts}`;
};

/* 16 — Regional OTT Top 10: a disc split into regions. */
scenes["regional-ott-top-10"] = (x, y, w, h) => {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const R = h * 0.32;
  const segs = Array.from({ length: 8 }, (_, i) => {
    const a0 = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2 - Math.PI / 2;
    const on = i % 3 === 0;
    return `<path d="M ${n(cx)} ${n(cy)} L ${n(cx + R * Math.cos(a0))} ${n(cy + R * Math.sin(a0))} A ${n(R)} ${n(R)} 0 0 1 ${n(cx + R * Math.cos(a1))} ${n(cy + R * Math.sin(a1))} Z" fill="${on ? "rgba(200,169,106,0.2)" : "rgba(255,255,255,0.05)"}" stroke="rgba(255,255,255,0.22)" stroke-width="1.5"/>`;
  }).join("\n    ");
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * 1.5)}" fill="url(#glow)"/>
    ${segs}
    <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R)}" fill="none" stroke="url(#ivoryS)" stroke-width="2.4"/>
    <circle cx="${n(cx)}" cy="${n(cy)}" r="7" fill="${ACCENT}"/>`;
};

/* 17 — Regional OTT: a broadcast source with radiating arcs. */
scenes["regional-ott"] = (x, y, w, h) => {
  const cx = x + w * 0.5;
  const baseY = y + h * 0.76;
  const arcs = [0.14, 0.24, 0.34, 0.44]
    .map((k, i) => `<path d="M ${n(cx - h * k)} ${n(baseY)} A ${n(h * k)} ${n(h * k)} 0 0 1 ${n(cx + h * k)} ${n(baseY)}" fill="none" stroke="url(#ivoryS)" stroke-width="2.4" opacity="${0.85 - i * 0.16}"/>`)
    .join("\n    ");
  const mast = `<line x1="${n(cx)}" y1="${n(baseY)}" x2="${n(cx)}" y2="${n(baseY - h * 0.16)}" stroke="url(#ivoryS)" stroke-width="3"/>
    <circle cx="${n(cx)}" cy="${n(baseY - h * 0.18)}" r="8" fill="${ACCENT}"/>`;
  return `<circle cx="${n(cx)}" cy="${n(baseY - h * 0.1)}" r="${n(h * 0.6)}" fill="url(#glow)"/>
    ${arcs}
    ${mast}
    <line x1="${n(x + w * 0.12)}" y1="${n(baseY)}" x2="${n(x + w * 0.88)}" y2="${n(baseY)}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.45"/>`;
};

/* 18 — On the Board: a rising arrival rail ending in a fresh spark. */
scenes["on-the-board"] = (x, y, w, h) => {
  const x0 = x + w * 0.15;
  const x1 = x + w * 0.84;
  const y0 = y + h * 0.79;
  const y1 = y + h * 0.31;
  const N = 5;
  const nodes = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    const px = x0 + (x1 - x0) * t;
    const py = y0 + (y1 - y0) * t;
    const lamp = i === N - 1;
    return lamp
      ? `<circle cx="${n(px)}" cy="${n(py)}" r="${n(h * 0.11)}" fill="url(#glow)"/>\n    <path d="${star(px, py, h * 0.075, h * 0.021)}" fill="${ACCENT}"/>`
      : `<circle cx="${n(px)}" cy="${n(py)}" r="8" fill="none" stroke="url(#ivoryS)" stroke-width="2.5" opacity="${0.45 + t * 0.45}"/>\n    <circle cx="${n(px)}" cy="${n(py)}" r="3" fill="#E7EBF3" opacity="${0.4 + t * 0.5}"/>`;
  }).join("\n    ");
  const ticks = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    const px = x0 + (x1 - x0) * t;
    const py = y0 + (y1 - y0) * t;
    return `<line x1="${n(px)}" y1="${n(py + h * 0.05)}" x2="${n(px)}" y2="${n(py + h * 0.09)}" stroke="url(#ivoryS)" stroke-width="2" opacity="0.22"/>`;
  }).join("\n    ");
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(y + h * 0.5)}" r="${n(h * 0.55)}" fill="url(#glow)"/>
    <line x1="${n(x0)}" y1="${n(y0)}" x2="${n(x1)}" y2="${n(y1)}" stroke="url(#ivoryS)" stroke-width="2.4" opacity="0.6"/>
    ${ticks}
    ${nodes}`;
};

/* 19 — Watchlist: a stack of queued cards, each with a bookmark ribbon. */
scenes["watchlist"] = (x, y, w, h) => {
  const cw = w * 0.5;
  const chh = h * 0.32;
  const cards = [
    { i: 2, front: false },
    { i: 1, front: false },
    { i: 0, front: true },
  ]
    .map(({ i, front }) => {
      const px = x + w * 0.24 + i * w * 0.05;
      const py = y + h * 0.36 - i * h * 0.08;
      const bt = 4 + w * 0.021; // bookmark ribbon size
      const bx = px + cw - bt - 14;
      const ribbon = `<path d="M ${n(bx)} ${n(py + 12)} h ${n(bt)} v ${n(bt * 1.05)} l ${n(-bt / 2)} ${n(-bt * 0.34)} l ${n(-bt / 2)} ${n(bt * 0.34)} Z" fill="${front ? ACCENT : "rgba(255,255,255,0.5)"}"/>`;
      const inner = front
        ? `<circle cx="${n(px + cw * 0.2)}" cy="${n(py + chh * 0.5)}" r="${n(h * 0.045)}" fill="none" stroke="${ACCENT}" stroke-width="2.4"/>\n      <path d="M ${n(px + cw * 0.2 - h * 0.016)} ${n(py + chh * 0.5)} l ${n(h * 0.014)} ${n(h * 0.016)} l ${n(h * 0.026)} ${n(-h * 0.032)}" fill="none" stroke="${ACCENT}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>\n      <line x1="${n(px + cw * 0.32)}" y1="${n(py + chh * 0.4)}" x2="${n(px + cw * 0.78)}" y2="${n(py + chh * 0.4)}" stroke="rgba(255,255,255,0.5)" stroke-width="3" stroke-linecap="round"/>\n      <line x1="${n(px + cw * 0.32)}" y1="${n(py + chh * 0.62)}" x2="${n(px + cw * 0.62)}" y2="${n(py + chh * 0.62)}" stroke="rgba(255,255,255,0.28)" stroke-width="3" stroke-linecap="round"/>`
        : "";
      return `<rect x="${n(px)}" y="${n(py)}" width="${n(cw)}" height="${n(chh)}" rx="14" fill="${front ? "#15171E" : "#0F1116"}" stroke="${front ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)"}" stroke-width="2"/>\n      ${inner}\n      ${ribbon}`;
    })
    .join("\n    ");
  return `<circle cx="${n(x + w * 0.5)}" cy="${n(y + h * 0.5)}" r="${n(h * 0.55)}" fill="url(#glow)"/>
    ${cards}`;
};

/* ------------------------------------------------------------ collections */

// The collection list (and its order) lives in ./collections.mjs so the cover
// generator and the catalog addon stay in lockstep. See that file for the keys.

const ROWS = [
  { dir: "movies", title: "Movies", mirror: false },
  { dir: "shows", title: "Shows", mirror: true },
];

/* --------------------------------------------------------------- renderer */

const TITLE_FAMILY = "Inter";
const TITLE_WEIGHT = 800;
const TRACK = -0.035; // em — tight display tracking
const layout = new Map();

// Every cover title renders at ONE size. Titles used to be sized per card (a
// 1-line title got 250px, a 2-line 186px, then shrink-to-fit), which is why
// long titles like "Genre from Decades" came out far smaller than their
// neighbours. TITLE_SIZE is the largest size that still fits every
// collection's widest line, so no card's title can look smaller than another's.
const TITLE_AVAIL = TEXT_RIGHT - PAD;
// A card can wear a different name on each row (`linesByRow`) — the Runtimes card
// is **Episodes** on Shows — so the one shared size has to fit every line of every
// name, not just the card's default one.
const allLines = (c) => [c.lines, ...Object.values(c.linesByRow ?? {})];

const TITLE_SIZE = (() => {
  const fits = (size) => {
    const ls = TRACK * size;
    return COLLECTIONS.every((c) =>
      allLines(c).every((set) => set.every((l) => measure(l, size, TITLE_WEIGHT, ls) <= TITLE_AVAIL)),
    );
  };
  let lo = 1;
  let hi = 260;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
})();

// The subtitle is the catalog's own name (the addon row name) — never an
// editorial descriptor. Small, wide-tracked, muted ivory; "Now on AutoCAT" is
// one card with no label.
const CENTER_Y = H / 2 + 26;
const SUB_WEIGHT = 600;
const SUB_TRACK = 0.2; // em
const SUB_GAP = 50;
const SUB_COLOR = "rgba(231,235,243,0.52)";
const SUB_MAX = 32;
const SUB_MIN = 18;
const SUB_SEP = "  ·  ";

// The subtitle names the catalogs that live inside the card — "Discover" →
// Latest, Newest, Trending, Popular, Top Rated — so it can differ between
// the movies and shows rows. Names wrap onto as many lines as needed and shrink
// to fit. Never an editorial descriptor.
function wrapLabels(labels, size, maxW) {
  const lines = [];
  let cur = "";
  for (const label of labels) {
    const test = cur ? cur + SUB_SEP + label : label;
    if (cur && measure(test, size, SUB_WEIGHT, SUB_TRACK * size) > maxW) {
      lines.push(cur);
      cur = label;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitSubtitle(labels, maxW) {
  for (let size = SUB_MAX; size >= SUB_MIN; size--) {
    const lines = wrapLabels(labels, size, maxW);
    const widest = Math.max(...lines.map((l) => measure(l, size, SUB_WEIGHT, SUB_TRACK * size)));
    if (widest <= maxW) return { size, lines };
  }
  return { size: SUB_MIN, lines: wrapLabels(labels, SUB_MIN, maxW) };
}

// A card can own many catalogs (18 genres, 16 countries, 8 decades). A cover
// cannot list them all, so keep the subtitle to at most 3 lines, summarising the
// rest as "+N more". Short lists are shown in full.
const SUB_MAX_LINES = 3;
const SUB_MAX_LABELS = 6;
function coverLabels(all) {
  if (all.length <= 2) return all;
  for (let n = Math.min(all.length, SUB_MAX_LABELS); n >= 1; n--) {
    const labels = n === all.length ? all : [...all.slice(0, n), `+${all.length - n} more`];
    if (fitSubtitle(labels, TITLE_AVAIL).lines.length <= SUB_MAX_LINES) return labels;
  }
  return [all[0], `+${all.length - 1} more`];
}

function sceneDefs() {
  return `
    <linearGradient id="ivoryS" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#9AA2B4"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.26"/>
      <stop offset="0.55" stop-color="${ACCENT}" stop-opacity="0.05"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="beamG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="barG" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#3A3F4D"/><stop offset="0.6" stop-color="#C9CEDB"/><stop offset="1" stop-color="#FFFFFF"/>
    </linearGradient>
    <linearGradient id="colG" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#4A5060" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#E8ECF4"/>
    </linearGradient>
    <radialGradient id="disc" cx="0.38" cy="0.34" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0.12"/>
    </radialGradient>`;
}

function buildSVG(cat, row) {
  const seed = hash(cat.key + ":" + row.dir);
  const rand = rng(seed);
  const draw = scenes[cat.scene];

  // A slow, non-hue breath on the champagne glow keeps the SVG masters alive
  // without any colour shift.
  const scene = draw(CARD_X, CARD_Y, CARD_W, CARD_H, rand).replaceAll(
    'fill="url(#glow)"',
    'fill="url(#glow)" class="glow"',
  );
  const mirror = row.mirror
    ? ` transform="translate(${n(2 * CARD_CX)} 0) scale(-1 1)"`
    : "";

  // The name this cover carries: Runtimes on Movies, **Episodes** on Shows.
  const lines = cat.linesByRow?.[row.dir === "movies" ? "movie" : "show"] ?? cat.lines;
  const size = TITLE_SIZE;
  const ls = TRACK * size;
  const lineH = size * 0.96;
  const titleBlockH = (lines.length - 1) * lineH + size;

  const labels = coverLabels(catalogLabels(cat, row.dir === "movies" ? "movie" : "show"));
  const sub = labels.length ? fitSubtitle(labels, TITLE_AVAIL) : null;
  const subLineH = sub ? sub.size * 1.42 : 0;
  const subBlockH = sub ? (sub.lines.length - 1) * subLineH + sub.size : 0;
  const totalH = titleBlockH + (sub ? SUB_GAP + subBlockH : 0);
  const top = CENTER_Y - totalH / 2;
  const firstBase = top + size * 0.76;
  const subFirstBase = sub ? top + titleBlockH + SUB_GAP + sub.size * 0.8 : 0;
  const bottom = sub
    ? subFirstBase + (sub.lines.length - 1) * subLineH + sub.size * 0.2
    : firstBase + (lines.length - 1) * lineH + size * 0.22;

  const titleEls = lines
    .map(
      (line, i) =>
        `    <text x="${PAD}" y="${n(firstBase + i * lineH)}" font-family="${TITLE_FAMILY}" font-size="${size}" font-weight="${TITLE_WEIGHT}" letter-spacing="${ls.toFixed(2)}" fill="url(#titleFill)">${esc(line)}</text>`,
    )
    .join("\n");

  const subEl = sub
    ? sub.lines
        .map(
          (l, i) =>
            `\n    <text x="${PAD}" y="${n(subFirstBase + i * subLineH)}" font-family="${TITLE_FAMILY}" font-size="${sub.size}" font-weight="${SUB_WEIGHT}" letter-spacing="${(SUB_TRACK * sub.size).toFixed(2)}" fill="${SUB_COLOR}">${esc(l)}</text>`,
        )
        .join("")
    : "";

  const desc = `${lines.join(" ")} — ${row.title.toLowerCase()} collection cover`;
  const widest = Math.max(...lines.map((l) => measure(l, size, TITLE_WEIGHT, ls)));
  const subWidest = sub
    ? Math.max(...sub.lines.map((l) => measure(l, sub.size, SUB_WEIGHT, SUB_TRACK * sub.size)))
    : 0;

  layout.set(cat.key + "/" + row.dir, {
    widest: widest + PAD,
    limit: TEXT_RIGHT,
    top,
    bottom,
    subWidest: subWidest + PAD,
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(desc)}" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <title>${esc(desc)}</title>
  <defs>
    <linearGradient id="titleFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#D7DCE6"/>
    </linearGradient>
    <linearGradient id="feather" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${PANEL_BG}" stop-opacity="1"/>
      <stop offset="0.6" stop-color="${PANEL_BG}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${PANEL_BG}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="panelShade" x1="0" y1="0" x2="1" y2="0.5">
      <stop offset="0" stop-color="rgba(6,7,10,0)"/>
      <stop offset="1" stop-color="rgba(6,7,10,0.42)"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.42" cy="0.5" r="0.85">
      <stop offset="0.55" stop-color="rgba(0,0,0,0)"/>
      <stop offset="1" stop-color="rgba(0,0,0,0.45)"/>
    </radialGradient>
    <clipPath id="cardClip">
      <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_R}"/>
    </clipPath>
${sceneDefs()}
    <style>
      .glow { animation: glowPulse 11s ease-in-out infinite; }
      @keyframes glowPulse { 0%,100% { opacity: 0.68; } 50% { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .glow { animation: none; } }
    </style>
  </defs>

  <rect x="0" y="0" width="${W}" height="${H}" fill="${INK}"/>

  <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_R}" fill="${PANEL_BG}"/>
  <g clip-path="url(#cardClip)">
    <g${mirror}>
      ${scene}
    </g>
    <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_W}" height="${CARD_H}" fill="url(#panelShade)"/>
    <rect x="${CARD_X}" y="${CARD_Y}" width="${n(CARD_W * 0.42)}" height="${CARD_H}" fill="url(#feather)"/>
  </g>
  <rect x="${CARD_X + 0.75}" y="${CARD_Y + 0.75}" width="${CARD_W - 1.5}" height="${CARD_H - 1.5}" rx="${CARD_R}" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="1.5"/>
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#vignette)"/>

  <g>
${titleEls}${subEl}
  </g>

  <rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>
</svg>
`;
}

/* ----------------------------------------------------------------- gallery */

function buildGallery(manifest) {
  const byCollection = new Map();
  for (const m of manifest) {
    if (!byCollection.has(m.collection)) byCollection.set(m.collection, { title: m.title, rows: [] });
    byCollection.get(m.collection).rows.push(m);
  }

  const sections = [...byCollection.values()]
    .map(({ title, rows }) => {
      const cards = rows
        .map((r) => {
          const dir = r.row === "movie" ? "movies" : "shows";
          const label = r.row === "movie" ? "Movies" : "Shows";
          return `      <figure class="card">
        <img src="./${dir}/${r.collection}.svg" alt="${esc(r.title)} — ${esc(label)} cover" loading="lazy">
        <figcaption><span class="tag">${label}</span><a class="dl" href="./${dir}/${r.collection}.png" download>PNG</a><a class="dl" href="./${dir}/${r.collection}.svg" download>SVG</a></figcaption>
      </figure>`;
        })
        .join("\n");
      return `  <section>
    <header><h2>${esc(title)}</h2><code>${rows[0].collection}</code></header>
    <div class="row">
${cards}
    </div>
  </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoCAT — collection covers</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 56px 40px 96px; background: #08090C; color: #E8EAF2;
         font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .head { max-width: 1240px; margin: 0 auto 56px; }
  .head h1 { font-size: 40px; font-weight: 800; letter-spacing: -0.03em; margin: 0 0 10px; }
  .head p { margin: 0; color: rgba(255,255,255,0.58); font-size: 16px; }
  main { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 56px; }
  section header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
  section h2 { font-size: 20px; font-weight: 700; letter-spacing: -0.015em; margin: 0; }
  section code { font-size: 12px; color: rgba(255,255,255,0.32); }
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 20px; }
  .card { margin: 0; }
  .card img { display: block; width: 100%; height: auto; border-radius: 14px;
              border: 1px solid rgba(255,255,255,0.08); background: #0B0C10; }
  figcaption { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 13px; }
  .tag { color: rgba(255,255,255,0.72); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; font-size: 11px; }
  .dl { color: rgba(255,255,255,0.42); text-decoration: none; border-bottom: 1px solid rgba(255,255,255,0.16); }
  .dl:hover { color: #fff; border-color: #fff; }
  .dl:first-of-type { margin-left: auto; }
</style>
</head>
<body>
<div class="head">
  <h1>AutoCAT — collection covers</h1>
  <p>${manifest.length} landscape covers · ${COLLECTIONS.length} collections × movies &amp; shows · procedural vector scenes with 1920×1080 PNG exports.</p>
</div>
<main>
${sections}
</main>
</body>
</html>
`;
}

/* ------------------------------------------------------------------- main */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  const report = [];

  for (const row of ROWS) {
    const dir = path.join(OUT_DIR, row.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const cat of COLLECTIONS) {
      const svg = buildSVG(cat, row);

      fs.writeFileSync(path.join(dir, `${cat.key}.svg`), svg);

      const resvg = new Resvg(svg, {
        fitTo: { mode: "original" },
        shapeRendering: 2,
        textRendering: 2,
        imageRendering: 0,
        font: {
          fontFiles,
          loadSystemFonts: false,
          defaultFontFamily: TITLE_FAMILY,
          sansSerifFamily: TITLE_FAMILY,
        },
      });
      const rendered = resvg.render();
      const png = rendered.asPng();
      fs.writeFileSync(path.join(dir, `${cat.key}.png`), png);

      report.push({
        file: `${row.dir}/${cat.key}`,
        px: `${rendered.width}x${rendered.height}`,
        png: png.length,
      });

      manifest.push({
        collection: cat.key,
        title: collectionTitle(cat),
        subtitle: subtitleOf(cat, row.dir === "movies" ? "movie" : "show"),
        row: row.dir === "movies" ? "movie" : "show",
        svg: `covers/${row.dir}/${cat.key}.svg`,
        png: `covers/${row.dir}/${cat.key}.png`,
      });
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), buildGallery(manifest));

  const problems = [];
  for (const [id, m] of layout) {
    if (m.widest > m.limit + 1) problems.push(`${id}: title overflows its column (${m.widest.toFixed(0)} > ${m.limit})`);
    if (m.subWidest > m.limit + 1) problems.push(`${id}: subtitle overflows its column (${m.subWidest.toFixed(0)} > ${m.limit})`);
    if (m.top < 70) problems.push(`${id}: title runs off the top (${m.top.toFixed(0)})`);
    if (m.bottom > H - 70) problems.push(`${id}: title runs off the bottom (${m.bottom.toFixed(0)})`);
  }

  console.log(`Generated ${manifest.length} covers (${COLLECTIONS.length} collections x 2 rows) — uniform title ${TITLE_SIZE}px.`);
  for (const r of report) {
    console.log(`  ${r.file.padEnd(42)} ${r.px.padEnd(10)} ${(r.png / 1024).toFixed(0)}kB`);
  }
  if (problems.length) {
    console.error(`\nLAYOUT CHECK FAILED (${problems.length}):`);
    problems.forEach((p) => console.error("  - " + p));
    process.exitCode = 1;
  } else {
    console.log("\nLayout check: OK — no overflow, nothing off-frame");
  }
}

main();
