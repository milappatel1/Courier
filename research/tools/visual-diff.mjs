// Compare Courier's captures with the web client's, state by state, under the threshold in
// research/look/LOOK-SPEC.md ("Visual diff threshold").
//
//   node research/tools/visual-diff.mjs [--threshold <pct>] [--tolerance <0-255>] [--only <substring>] [--json]
//
// Inputs are the 1x goldens research/goldens/web/<name>-1x.png and research/goldens/courier/<name>-1x.png
// (capture them with goldens.mjs). Output: a table on stdout, research/goldens/diff/<name>.png (red = differing
// pixel, dimmed = equal, blue = masked) and <name>-side.png (web | courier | diff). Exit 1 when any state is over the
// threshold or cannot be compared. No dependencies: PNGs are decoded with node:zlib.
//
// What is counted: pixels inside the compared regions and outside the masks. A pixel differs when any channel
// differs by more than the tolerance. Ink is a compared pixel that is not near-white in the web golden or in
// Courier's (text, icons, borders, fills). The score is differing / ink as a percentage, so a mostly blank page
// cannot hide a misplaced icon: 0 means every ink pixel coincides, 100 means none does. "area %" is
// differing / compared and is printed for reference only.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const goldens = join(here, "..", "goldens");

export const DEFAULTS = { threshold: 10, tolerance: 24, radius: 1 };

// ---------------------------------------------------------------------------------------------------------------
// Masks and regions. Rectangles are [x, y, w, h] in CSS px of the web golden (1280 x 728 unless the state is
// narrower). The web goldens were captured with Chat and Meet on and the side panel open; Courier has neither, so
// the Courier captures reserve the same gutters (plans/courier.json) and the Google-only strips are masked here.

const HEADER_H = 64;
const GUTTER_RIGHT = 56;

// Header: only the search box's left end is comparable. The logo, the status pill, Help, Settings, the Gemini spark,
// Upgrade, the app grid and the avatar are Google's, and the search box ends at a different x on each side.
// courierDx is how far Courier's search box sits left of the web's: the web header is offset by the 68 px rail in
// both nav states, Courier's capture is inset 12 px (nav collapsed) or 68 px (nav open).
const headerRegion = (layout) => ({ name: "header-search", rect: [324, 0, 376, HEADER_H], dx: layout === "open" ? 0 : 56 });

const rail = (layout) => [0, HEADER_H, layout === "open" ? 68 : 84, 9999];
const sidePanel = (w) => [w - GUTTER_RIGHT, 0, GUTTER_RIGHT, 9999];
const scrollbar = (w) => [w - 74, HEADER_H, 18, 9999];
// Page count, newer/older arrows, "N of M", the input-tools keyboard button: counts depend on the mailbox and the
// keyboard button is Google's.
const toolbarRight = (w) => [w - 300, HEADER_H, 244, 52];
// Everything the mailbox decides in a list: rows (sender, subject, snippet, date, label chips, attachment chips, tint,
// star state, row count), the footer's storage bar, "Terms Privacy" links and last-account-activity text.
const rowsFrom = (y, layout) => [layout === "open" ? 324 : 84, y, 1224, 9999];

// The web list's horizontal scrollbar under chip lists.
const hScrollbar = [84, 696, 1124, 16];
const BASE = (layout, w) => [rail(layout), sidePanel(w), scrollbar(w), hScrollbar, toolbarRight(w)];

// Overlays that sit on top of the rows: the rows mask is lifted inside these rectangles so the overlay is compared.
// An optional fifth number is how far Courier's overlay sits left of the web's for a reason that is the web capture's
// layout, not Courier's: 56 for the advanced-search dialog, which hangs off the header (same reason as the header
// region), and -10 for compose, which docks to the window edge (LOOK-SPEC: right offset 61 px with Chat off) while the
// web golden's side panel pushes it 10 px further left.
const KEEP = {
  compose: [[648, 185, 566, 527, -10]],
  "row-hover": [[84, 248, 150, 40], [1040, 248, 170, 40]],
  "row-selected-toolbar": [[84, 248, 150, 40], [1040, 248, 170, 40]],
  "list-more-menu": [[192, 96, 272, 116]],
  "toolbar-more-menu": [[388, 98, 292, 312]],
  "row-context-menu": [[640, 136, 290, 592]],
  "advanced-search": [[320, 60, 730, 440, 56]],
  "quick-settings": [[880, 64, 344, 648]],
};
// Nav (open): the mailbox decides the counts and which categories and labels are listed below Drafts.
const navData = [[270, 150, 50, 160], [68, 310, 256, 9999]];

// Conversation: the message header's picture, names, time and "to me" (hidden on the web side, shown in Courier's
// mock mail) and the label chips, which are the thread's.
const CONV = [[100, 170, 990, 60], [380, 130, 520, 32]];

// state -> { layout: nav "collapsed" | "open", masks: added to BASE }
const TABBED = { layout: "collapsed", masks: (l) => [rowsFrom(168, l)] };
const STATES = {
  "inbox-primary": TABBED,
  "inbox-promotions": TABBED,
  "inbox-social": TABBED,
  "inbox-primary-1024": TABBED,
  "inbox-primary-800": TABBED,
  "row-hover": TABBED,
  "row-selected-toolbar": TABBED,
  "toolbar-more-menu": TABBED,
  "list-more-menu": TABBED,
  "row-context-menu": TABBED,
  "inbox-updates-empty": { layout: "collapsed", masks: () => [[84, 490, 1140, 222]] },
  "sent-empty": { layout: "collapsed", masks: () => [[84, 490, 1140, 222]] },
  compose: { layout: "open", masks: (l) => [rowsFrom(168, l), ...navData] },
  "advanced-search": TABBED,
  "quick-settings": { layout: "collapsed", masks: (l) => [rowsFrom(168, l), [780, 64, 100, 52]] },
  "search-results": TABBED,
  starred: TABBED,
  "label-view": TABBED,
  "all-mail": TABBED,
  "category-updates-label": TABBED,
  "trash-banner": { layout: "collapsed", masks: (l) => [rowsFrom(222, l)] },
  "spam-banner": { layout: "collapsed", masks: (l) => [rowsFrom(222, l)] },
  "message-more-menu": { layout: "collapsed", masks: () => [...CONV, [950, 386, 215, 22]] },
  conversation: { layout: "collapsed", masks: () => CONV },

};
for (const t of ["general", "labels", "inbox", "accounts", "filters", "fwdandpop", "advanced", "offline"]) STATES[`settings-${t}`] = { layout: "collapsed", masks: () => [] };
const FALLBACK = { layout: "collapsed", masks: () => [] };

export function maskFor(name, w = 1280) {
  const st = STATES[name] ?? FALLBACK;
  return { layout: st.layout, masks: [...BASE(st.layout, w), ...st.masks(st.layout)], keep: KEEP[name] ?? [] };
}

// ---------------------------------------------------------------------------------------------------------------
// PNG in, PNG out.

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("latin1", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") [w, h, depth, color, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  if (depth !== 8 || interlace || (color !== 2 && color !== 6)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})`);
  const bpp = color === 6 ? 4 : 3, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4, 255);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (cur[i] + add) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = cur[x * bpp];
      px[o + 1] = cur[x * bpp + 1];
      px[o + 2] = cur[x * bpp + 2];
      if (bpp === 4) px[o + 3] = cur[x * bpp + 3];
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, px };
}

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
export function encodePng({ w, h, px }) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = px[s];
      raw[d + 1] = px[s + 1];
      raw[d + 2] = px[s + 2];
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------------------------------------------
// The comparison.

// Whether some pixel of `other` within `radius` of (x, y) matches a's pixel there within the tolerance. Lets a
// one-pixel shift or a different antialiasing of the same glyph pass while a real displacement does not.
function near(a, x, y, otherPx, tolerance, radius) {
  const o = (y * a.w + x) * 4;
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= a.w || yy >= a.h) continue;
      const q = (yy * a.w + xx) * 4;
      if (Math.abs(a.px[o] - otherPx[q]) <= tolerance && Math.abs(a.px[o + 1] - otherPx[q + 1]) <= tolerance && Math.abs(a.px[o + 2] - otherPx[q + 2]) <= tolerance) return true;
    }
  return false;
}

export function compare(web, courier, name, tolerance, radius = DEFAULTS.radius, headerDx) {
  const { layout, masks, keep } = maskFor(name, web.w);
  const { w, h } = web;
  const masked = new Uint8Array(w * h);
  for (const [x0, y0, mw, mh] of masks)
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + mh); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + mw); x++) masked[y * w + x] = 1;

  for (const [x0, y0, kw, kh] of keep)
    for (let y = Math.max(HEADER_H, y0); y < Math.min(h, y0 + kh); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + kw); x++) masked[y * w + x] = 0;
  const dxAt = (x, y) => {
    if (y < HEADER_H) return hdr.dx;
    for (const [x0, y0, kw, kh, dx = 0] of keep) if (x >= x0 && x < x0 + kw && y >= y0 && y < y0 + kh) return dx;
    return 0;
  };

  const hdr = headerRegion(layout);
  if (headerDx !== undefined) hdr.dx = headerDx;
  const aligned = Buffer.alloc(w * h * 4, 255);
  const have = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const cx = x - dxAt(x, y);
      if (cx < 0 || cx >= courier.w || y >= courier.h) continue;
      have[y * w + x] = 1;
      courier.px.copy(aligned, (y * w + x) * 4, (y * courier.w + cx) * 4, (y * courier.w + cx) * 4 + 4);
    }
  const alignedImg = { w, h, px: aligned };
  const diff = Buffer.alloc(w * h * 4, 255);
  let compared = 0, differing = 0, ink = 0;
  const far = (px, o) => Math.max(255 - px[o], 255 - px[o + 1], 255 - px[o + 2]) > tolerance;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = y < HEADER_H ? w >= 1024 && x >= hdr.rect[0] && x < hdr.rect[0] + hdr.rect[2] : !masked[y * w + x];
      if (!inside) {
        for (let k = 0; k < 3; k++) diff[o + k] = Math.round(web.px[o + k] * 0.25 + [200, 215, 255][k] * 0.75);
        continue;
      }
      compared++;
      const bad = !have[y * w + x] || !near(web, x, y, aligned, tolerance, radius) || !near(alignedImg, x, y, web.px, tolerance, radius);
      if (bad || far(web.px, o) || far(aligned, o)) ink++;
      if (bad) {
        differing++;
        diff[o] = 220, diff[o + 1] = 30, diff[o + 2] = 30;
      } else for (let k = 0; k < 3; k++) diff[o + k] = Math.round(web.px[o + k] * 0.35 + 255 * 0.65);
    }
  return { compared, differing, ink, area: compared ? (differing / compared) * 100 : 0, pct: ink ? (differing / ink) * 100 : 0, diff: { w, h, px: diff }, aligned: alignedImg };
}

function sideBySide(web, a, d) {
  const w = web.w, h = web.h, px = Buffer.alloc(w * 3 * h * 4, 255);
  for (let y = 0; y < h; y++)
    [web.px, a.px, d.px].forEach((src, i) => src.copy(px, (y * w * 3 + i * w) * 4, y * w * 4, (y + 1) * w * 4));
  return { w: w * 3, h, px };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const threshold = Number(opt("--threshold", DEFAULTS.threshold));
  const tolerance = Number(opt("--tolerance", DEFAULTS.tolerance));
  const only = opt("--only", "");
  const radius = Number(opt("--radius", DEFAULTS.radius));
  const names = readdirSync(join(goldens, "web"))
    .filter((f) => f.endsWith("-1x.png"))
    .map((f) => f.slice(0, -7))
    .filter((n) => existsSync(join(goldens, "courier", `${n}-1x.png`)) && n.includes(only))
    .sort();
  if (!names.length) {
    console.error("no state has both a web and a courier 1x golden; run goldens.mjs for both sides first");
    process.exit(2);
  }
  mkdirSync(join(goldens, "diff"), { recursive: true });
  const rows = [];
  for (const name of names) {
    const web = decodePng(readFileSync(join(goldens, "web", `${name}-1x.png`)));
    const courier = decodePng(readFileSync(join(goldens, "courier", `${name}-1x.png`)));
    if (web.w !== courier.w || web.h !== courier.h) {
      rows.push({ name, note: `size ${courier.w}x${courier.h} != web ${web.w}x${web.h}`, ok: false });
      continue;
    }
    const r = compare(web, courier, name, tolerance, radius);
    writeFileSync(join(goldens, "diff", `${name}.png`), encodePng(r.diff));
    writeFileSync(join(goldens, "diff", `${name}-side.png`), encodePng(sideBySide(web, r.aligned, r.diff)));
    rows.push({ name, pct: r.pct, area: r.area, ink: r.ink, compared: r.compared, differing: r.differing, ok: r.pct <= threshold, masked: STATES[name] ? "" : "no per-state masks" });
  }
  if (args.includes("--json")) console.log(JSON.stringify({ threshold, tolerance, rows }, null, 1));
  else {
    const pad = Math.max(...rows.map((r) => r.name.length));
    console.log(`threshold ${threshold}% of ink pixels, tolerance ${tolerance}/255 per channel`);
    console.log(`${"state".padEnd(pad)}  diff %  area %      ink  result`);
    for (const r of rows)
      console.log(r.note ? `${r.name.padEnd(pad)}  ${r.note}  FAIL` : `${r.name.padEnd(pad)}  ${r.pct.toFixed(2).padStart(6)}  ${r.area.toFixed(2).padStart(6)}  ${String(r.ink).padStart(7)}  ${r.ok ? "pass" : "FAIL"}${r.masked ? "  (" + r.masked + ")" : ""}`);
    console.log(`${rows.filter((r) => r.ok).length}/${rows.length} within threshold; diff images in research/goldens/diff/`);
  }
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
