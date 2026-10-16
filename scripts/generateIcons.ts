// Regenerate the PWA icons (icon-192.png, icon-512.png, apple-touch-icon.png).
//
// To use your OWN artwork: drop a square image into client/public/icons/ named
// `icon-source.png` (or .jpg / .webp). This script picks it up automatically
// and produces all three sizes. If no source image is present it falls back to
// the built-in icon.svg.
//
// Requires sharp as a one-off dev dependency, then run with tsx:
//
//   npm i -D sharp && npx tsx scripts/generateIcons.ts && npm remove sharp
//
import fs from "fs";
import path from "path";
import { createRequire } from "module";

// The project is an ES module, so `require` isn't defined globally — recreate it
// so we can load sharp (an optional, dev-only dependency) at runtime.
const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ICONS_DIR = path.resolve(import.meta.dirname, "../client/public/icons");

// Prefer a raster source you dropped in; otherwise use the SVG.
const CANDIDATES = ["icon-source.png", "icon-source.jpg", "icon-source.webp", "icon.svg"];
const source = CANDIDATES.map((f) => path.join(ICONS_DIR, f)).find((p) => fs.existsSync(p));

const sizes: [number, string][] = [
  [512, "icon-512.png"],
  [192, "icon-192.png"],
  [180, "apple-touch-icon.png"],
];

async function main() {
  if (!source) {
    throw new Error(`No icon source found. Add one of: ${CANDIDATES.join(", ")} to ${ICONS_DIR}`);
  }
  console.log("Using source:", path.basename(source));
  const src = fs.readFileSync(source);
  for (const [size, file] of sizes) {
    await sharp(src, { density: 300 })
      .resize(size, size, { fit: "cover" })
      .png()
      .toFile(path.join(ICONS_DIR, file));
    console.log("wrote", file, `${size}x${size}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
