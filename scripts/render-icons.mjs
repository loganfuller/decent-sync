// Writes the management interface's browser icons into web/public, which the
// build copies as is, from the logomark (web/src/assets/decent-sync-logomark.svg):
// favicon.svg, a copy of it; favicon.ico, at 16, 32 and 48 px, for browsers
// that take no SVG favicon; and apple-touch-icon.png, 180 px on white, for a
// home screen on iOS and iPadOS, which shows no transparency. Run it after
// changing the logomark, and commit what it writes. It draws them in
// Playwright's Chromium, which the e2e suite installs.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const logomark = path.join(root, "web/src/assets/decent-sync-logomark.svg");
const out = path.join(root, "web/public");

const svg = `data:image/svg+xml;base64,${fs.readFileSync(logomark).toString("base64")}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  /** The logomark as a PNG `size` px square, `scale` of its width, centred on `background`, or on nothing. */
  async function draw(size, { scale = 1, background } = {}) {
    const side = size * scale;
    const inset = (size - side) / 2;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0;background:${background ?? "transparent"}">` +
        `<img src="${svg}" style="position:absolute;left:${inset}px;top:${inset}px;width:${side}px;height:${side}px">` +
        "</body>",
    );
    await page.locator("img").evaluate((img) => img.decode());
    return page.screenshot({ omitBackground: !background });
  }

  const favicons = [];
  for (const size of [16, 32, 48]) favicons.push({ size, png: await draw(size) });
  fs.copyFileSync(logomark, path.join(out, "favicon.svg"));
  fs.writeFileSync(path.join(out, "favicon.ico"), ico(favicons));
  fs.writeFileSync(path.join(out, "apple-touch-icon.png"), await draw(180, { scale: 0.75, background: "#ffffff" }));
} finally {
  await browser.close();
}

/** An ICO file holding each PNG as one of its images, as browsers, and Windows since Vista, read them. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // An icon, not a cursor.
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size, entry); // Width and height, below 256.
    header.writeUInt8(size, entry + 1);
    header.writeUInt16LE(1, entry + 4); // Colour planes.
    header.writeUInt16LE(32, entry + 6); // Bits per pixel.
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}
