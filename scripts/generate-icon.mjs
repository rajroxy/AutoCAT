/**
 * **The app's icons, from the two SVGs the app draws.**
 *
 * `desktop/build/icon.svg` is the opening screen's own mark — the cat curled into the C — on the
 * app's ink, and `desktop/build/icon-foreground.svg` is the same animal sized for Android's
 * adaptive icon. Both are the *source*: every pixel that ships is rendered from them here, so the
 * icon on a launcher and the icon in an installer can never drift apart from each other.
 *
 * What it writes:
 *
 *   desktop/build/icon.png              1024 — what electron-builder reads (it makes the .ico and
 *                                       .icns for Windows and macOS from this one file)
 *   desktop/build/icons/*.png           16…512 — the hicolor sizes a Linux desktop needs
 *   desktop/ui/icon.png                 192 — the tab icon of the preview and of the app
 *   android …/mipmap-*dpi/ic_launcher.png          48…192, the launcher's square icon
 *   android …/mipmap-*dpi/ic_launcher_round.png    48…192, the same, masked to a circle
 *   android …/mipmap-*dpi/ic_launcher_foreground.png  108…432, the adaptive foreground
 *   android …/res/values/ic_launcher_background.xml   the adaptive background colour (the ink)
 *
 * **Nothing here is a build step.** The PNGs are committed, so a build (or a checkout someone
 * just cloned) has its icons without running this. It is run when the *illustration* changes:
 *
 *     npm run icon            # from the repository root, or `npm run icon` in desktop/
 *
 * Rendering is `sharp` — a prebuilt binary, no compiler — and it rasterizes SVG through its own
 * librsvg, so the two files above are also readable on GitHub as what they are.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON = join(ROOT, "desktop", "build", "icon.svg");
const FOREGROUND = join(ROOT, "desktop", "build", "icon-foreground.svg");
const ANDROID = join(ROOT, "desktop", "android", "app", "src", "main", "res");

/** The Android densities, as the launcher sizes them (dp × density). */
const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

/** The hicolor sizes a Linux desktop looks for, plus the big one for the app bundle. */
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

const write = async (path, buffer) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  return buffer.length;
};

/** A white circle on nothing, used to cut `ic_launcher_round` out of the square icon. */
const circleMask = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );

const round = async (buffer, size) =>
  sharp(buffer)
    .composite([{ input: circleMask(size), blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toBuffer();

const [icon, foreground] = await Promise.all([readFile(ICON, "utf8"), readFile(FOREGROUND, "utf8")]);

const written = [];
const sizes = async () => {
  // **electron-builder's own icon.** One 1024 px PNG is all it needs: it generates the Windows
  // `.ico` and the macOS `.icns` from this file.
  written.push([`desktop/build/icon.png`, await write(join(ROOT, "desktop", "build", "icon.png"), await png(icon, 1024))]);

  for (const size of LINUX_SIZES) {
    written.push([`desktop/build/icons/${size}x${size}.png`, await write(join(ROOT, "desktop", "build", "icons", `${size}x${size}.png`), await png(icon, size))]);
  }

  // The preview's tab icon — the same mark the launcher shows.
  written.push(["desktop/ui/icon.png", await write(join(ROOT, "desktop", "ui", "icon.png"), await png(icon, 192))]);

  for (const [name, scale] of DENSITIES) {
    const square = 48 * scale;
    const squarePng = await png(icon, square);
    written.push([`mipmap-${name}/ic_launcher.png`, await write(join(ANDROID, `mipmap-${name}`, "ic_launcher.png"), squarePng)]);
    written.push([`mipmap-${name}/ic_launcher_round.png`, await write(join(ANDROID, `mipmap-${name}`, "ic_launcher_round.png"), await round(squarePng, square))]);
    // The adaptive foreground is measured in 108 dp, not 48 — see the file's own comment.
    written.push([`mipmap-${name}/ic_launcher_foreground.png`, await write(join(ANDROID, `mipmap-${name}`, "ic_launcher_foreground.png"), await png(foreground, 108 * scale))]);
  }

  // **The adaptive background is the plate's own ink**, written here rather than left at the
  // template's white: a white circle behind a near-black animal is a different icon.
  await write(
    join(ANDROID, "values", "ic_launcher_background.xml"),
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B0B0B</color>\n</resources>\n`, "utf8"),
  );
  written.push(["android …/values/ic_launcher_background.xml", 0]);
};

await sizes();

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
console.log(`Icons → ${written.length} file(s)\n` + written.map(([name, bytes]) => `  ${name}${bytes ? `  (${kb(bytes)})` : ""}`).join("\n"));
