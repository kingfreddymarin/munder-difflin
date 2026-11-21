'use strict';
/**
 * Council brand mark: the owner's mark, a cream serif N with a small sparkle on
 * a black rounded tile, gold shading on the inner faces of the strokes.
 *
 * This is a vector REDRAW of the owner-supplied 55px source
 * (tools/council-logo-source-55.png), not a new design. Every outline point
 * below was read off that source's own pixel grid (edge position = partial
 * pixel coverage of the red channel, so gold shading is not mistaken for an
 * edge) and is scaled into the 1024 canvas by SRC. Colours are the source's
 * averaged tile, cream and gold.
 *
 * THE SVG IS THE SOURCE OF TRUTH, and every raster is computed from the same
 * shape list, never traced back from a PNG. Pure vector: one rounded rect and
 * cubic-Bezier paths, no fonts, no gradients, no filters.
 *
 * Full bleed, as Munder's icon is since 20ba890e: the tile meets the canvas
 * edge, so there is no transparent band shrinking it in the Dock.
 *
 * Writes:
 *   build/icon.svg    design source, 1024
 *   build/icon.png    1024 — Linux, and the electron-builder base
 *   build/icon.ico           Windows, 16..256
 *   build/icon.icns          macOS, 16..1024 (via iconutil; fails in the agent sandbox)
 *   logo-preview/council-{1024,128,32,16}.png   review previews
 *   logo-preview/council-vs-source-55.png       source | redraw, both at 55px, shown x8
 *
 *   node tools/make-council-logo.cjs
 *
 * Running tools/make-logo.cjs afterwards puts Munder's mark back in build/.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'tools/council-logo-source-55.png'; // the owner's mark (previews go to logo-preview/, not tracked)

// ── palette (averaged from the source) ───────────────────────────────────
const C = {
  tile:  [14, 15, 17],    // #0E0F11 near-black tile
  cream: [224, 213, 190], // #E0D5BE the letter and the sparkle
  gold:  [195, 151, 66]   // #C39742 shading on the faces that look down-left
};

// ── frame: the tile's place in the 55px source ───────────────────────────
// Measured from the alpha edge: the tile starts at (0.35, 1.0) and is 51.9
// source px square, with a 7.4px corner. It fills the 1024 canvas.
const SRC = { x0: 0.35, y0: 1.0, size: 51.9, corner: 7.4 };
const K = 1024 / SRC.size;
const P = ([x, y, smooth]) => [(x - SRC.x0) * K, (y - SRC.y0) * K, smooth];

// ── outlines, in source px. A third element of 1 makes the point smooth
// (the curve passes through it); every other point is a corner. ──────────
const N_OUTLINE = [
  // top-left serif: flat top, then the notch and the spike at the top of the stem
  [16.4, 13.95], [17.25, 14.6], [18.45, 12.1], [19.9, 14.0],
  // upper edge of the diagonal, one gentle curve down to the right stem
  [25.5, 24.0, 1], [34.5, 35.0],
  // left edge of the right stem, up to the top-right serif
  [34.0, 17.4],
  // top-right serif: round left end, a shallow dip over the stem, round right end
  [30.5, 17.3, 1], [29.55, 15.6, 1], [30.7, 13.8, 1], [36.3, 14.3, 1], [40.4, 13.85, 1],
  [42.0, 15.8, 1], [41.3, 17.25, 1], [39.0, 16.55, 1], [37.5, 17.6],
  // right edge of the right stem, straight, then flaring to the bottom right
  [38.2, 30.0, 1], [41.05, 40.7],
  // the two feet at the bottom right: stem end, notch, diagonal end
  [39.0, 41.15], [38.45, 40.05], [37.8, 40.95], [36.5, 40.9],
  // lower edge of the diagonal, one gentle curve back up to the crotch
  [26.6, 32.0, 1], [19.85, 23.6],
  // right edge of the left stem, the foot serif, the left edge going up
  [20.05, 36.8], [20.7, 38.6, 1], [22.1, 39.6], [21.3, 40.75, 1], [17.5, 41.25, 1], [13.3, 40.3],
  [15.3, 39.0, 1], [16.85, 36.8], [16.3, 18.1],
  // bracket into the underside of the top-left serif, round its left end
  [15.3, 17.0, 1], [12.6, 16.9, 1], [11.4, 15.45, 1], [12.6, 13.95, 1]
];

// Gold shading, clipped to the N: the lower face of the diagonal (from the
// crotch down) and the left face of the right stem. Each polygon's inner
// edge is drawn; its outer edge lies in the black and the clip trims it.
const GOLD_DIAGONAL = [
  [19.85, 23.6], [23.3, 25.2, 1], [33.8, 38.3], [33.0, 39.6], [21.0, 27.2], [19.95, 24.6]
];
const GOLD_STEM = [
  [33.0, 17.4], [35.0, 17.4], [35.6, 27.5, 1], [37.2, 36.5], [37.4, 38.2],
  [36.2, 37.6], [35.0, 35.6], [33.6, 33.0], [33.0, 31.0]
];

// The four-point sparkle above the right serif, its top-right quarter gold.
const SPARKLE = { x: 44.9, y: 9.3, up: 2.0, down: 1.9, left: 1.8, right: 1.8 };

// ── geometry: closed paths as cubic segments on the 1024 canvas ─────────
/** Catmull-Rom through smooth points, straight into and out of corners. */
function outline(points) {
  const p = points.map(P), n = p.length;
  const tangent = (i) => {
    if (!p[i][2]) return [0, 0];
    const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
    return [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2];
  };
  return p.map((a, i) => {
    const b = p[(i + 1) % n], ta = tangent(i), tb = tangent((i + 1) % n);
    return [a, [a[0] + ta[0] / 3, a[1] + ta[1] / 3], [b[0] - tb[0] / 3, b[1] - tb[1] / 3], b];
  });
}

/** Four tips joined by concave curves pulled toward the centre. */
function sparkle(s, quarter) {
  const c = P([s.x, s.y]);
  const tip = { up: P([s.x, s.y - s.up]), right: P([s.x + s.right, s.y]),
    down: P([s.x, s.y + s.down]), left: P([s.x - s.left, s.y]) };
  const pull = (a, b) => [a, [a[0] + (c[0] - a[0]) * 0.4, a[1] + (c[1] - a[1]) * 0.4],
    [b[0] + (c[0] - b[0]) * 0.4, b[1] + (c[1] - b[1]) * 0.4], b];
  const line = (a, b) => [a, a, b, b];
  if (quarter) return [pull(tip.up, tip.right), line(tip.right, c), line(c, tip.up)];
  return [pull(tip.up, tip.right), pull(tip.right, tip.down), pull(tip.down, tip.left), pull(tip.left, tip.up)];
}

/**
 * One ordered paint list, used by both the SVG writer and the rasteriser.
 * Each entry is the tile, or a path { segs, c, clip? } where clip names the
 * path it is drawn inside.
 */
function shapes() {
  const N = outline(N_OUTLINE);
  return [
    { kind: 'tile', c: C.tile },
    { kind: 'path', id: 'n', segs: N, c: C.cream },
    { kind: 'path', segs: outline(GOLD_DIAGONAL), c: C.gold, clip: N },
    { kind: 'path', segs: outline(GOLD_STEM), c: C.gold, clip: N },
    { kind: 'path', segs: sparkle(SPARKLE), c: C.cream },
    { kind: 'path', segs: sparkle(SPARKLE, true), c: C.gold }
  ];
}

// ── SVG ───────────────────────────────────────────────────────────────────
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const num = (v) => String(Math.round(v * 10) / 10);
const pt = (q) => `${num(q[0])} ${num(q[1])}`;

function pathData(segs) {
  const straight = (s) => s[1] === s[0] && s[2] === s[3]
    || (s[1][0] === s[0][0] && s[1][1] === s[0][1] && s[2][0] === s[3][0] && s[2][1] === s[3][1]);
  return `M${pt(segs[0][0])}` + segs.map((s) =>
    straight(s) ? `L${pt(s[3])}` : `C${pt(s[1])} ${pt(s[2])} ${pt(s[3])}`).join('') + 'Z';
}

function buildSvg() {
  const list = shapes();
  const n = list.find((s) => s.id === 'n');
  const R = num(SRC.corner * K);
  const body = list.map((s) => {
    if (s.kind === 'tile') return `  <rect width="1024" height="1024" rx="${R}" fill="${hex(s.c)}"/>`;
    const clip = s.clip ? ' clip-path="url(#n)"' : '';
    return `  <path fill="${hex(s.c)}"${clip} d="${pathData(s.segs)}"/>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- Council — the app mark: the owner's serif N with a sparkle, redrawn as vectors
       from the owner-supplied 55px source. Generated by tools/make-council-logo.cjs;
       edit that, not this. Pure vector: no fonts, no gradients, no filters. -->
  <title>Council</title>
  <defs><clipPath id="n"><path d="${pathData(n.segs)}"/></clipPath></defs>
${body}
</svg>
`;
}

// ── rasteriser ────────────────────────────────────────────────────────────
function sdRoundBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Cubic segments to a polygon's edges, 24 steps a curve. */
function edges(segs) {
  const out = [];
  for (const [a, b, c, d] of segs) {
    let prev = a;
    const steps = b === a && c === d ? 1 : 24;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      const q = [
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]
      ];
      out.push([prev[0], prev[1], q[0], q[1]]);
      prev = q;
    }
  }
  return out;
}

/** Nonzero-winding spans of a polygon on the row y: a sorted list of [x0, x1). */
function spans(poly, y) {
  const hits = [];
  for (const [x0, y0, x1, y1] of poly) {
    if ((y0 <= y) === (y1 <= y)) continue;
    hits.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
  }
  hits.sort((p, q) => p[0] - q[0]);
  const out = [];
  let w = 0, start = 0;
  for (const [x, d] of hits) {
    if (w === 0) start = x;
    w += d;
    if (w === 0) out.push([start, x]);
  }
  return out;
}
const within = (sp, x) => sp.some(([a, b]) => x >= a && x < b);

/**
 * Painter's algorithm per subsample, box-filtered. Output pixel (x, y) maps
 * to canvas (x * scale + ox, y * scale + oy), so the same code draws the
 * icon sizes and the redraw in the source's own 55px frame.
 */
function rasterise(W, H, scale, ox = 0, oy = 0) {
  const list = shapes().map((s) => s.kind === 'path'
    ? { ...s, poly: edges(s.segs), clipPoly: s.clip && edges(s.clip) } : s);
  const SS = W <= 64 ? 8 : 4;
  const out = Buffer.alloc(W * H * 4);
  const acc = new Float64Array(W * 4);
  for (let y = 0; y < H; y++) {
    acc.fill(0);
    for (let sy = 0; sy < SS; sy++) {
      const py = (y + (sy + 0.5) / SS) * scale + oy;
      const rows = list.map((s) => s.kind === 'path'
        ? { sp: spans(s.poly, py), clip: s.clipPoly && spans(s.clipPoly, py) } : null);
      for (let x = 0; x < W; x++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * scale + ox;
          let col = null;
          for (let i = list.length - 1; i >= 0; i--) {
            const s = list[i], r = rows[i];
            const hit = s.kind === 'tile'
              ? sdRoundBox(px - 512, py - 512, 512, 512, SRC.corner * K) <= 0
              : within(r.sp, px) && (!r.clip || within(r.clip, px));
            if (hit) { col = s.c; break; }
          }
          if (!col) continue;
          const j = x * 4;
          acc[j] += col[0]; acc[j + 1] += col[1]; acc[j + 2] += col[2]; acc[j + 3]++;
        }
      }
    }
    for (let x = 0; x < W; x++) {
      const j = x * 4, cov = acc[j + 3];
      if (!cov) continue;
      const i = (y * W + x) * 4;
      out[i] = Math.round(acc[j] / cov); out[i + 1] = Math.round(acc[j + 1] / cov);
      out[i + 2] = Math.round(acc[j + 2] / cov);
      out[i + 3] = Math.round((cov / (SS * SS)) * 255);
    }
  }
  return out;
}

// ── PNG (same encoder as tools/make-logo.cjs) ─────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(W, H, rgba) {
  const stride = W * 4 + 1;
  const raw = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Decode an 8-bit RGBA, non-interlaced PNG: enough for the owner's source. */
function decodePng(buf) {
  let p = 8, W = 0, H = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`${SOURCE}: expected 8-bit RGBA, non-interlaced`);
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = W * 4;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? out[(y - 1) * stride + x - 4] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + x] = (line[x] + pred) & 0xff;
    }
  }
  return { W, H, rgba: out };
}

/** Source and redraw side by side, each blown up x8 with hard pixels, on light grey. */
function sideBySide(src, ours, Z = 8, pad = 20) {
  const W = pad * 3 + src.W * Z * 2, H = pad * 2 + src.H * Z;
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) out.set([238, 238, 238, 255], i * 4);
  [src.rgba, ours].forEach((img, k) => {
    const left = pad + k * (src.W * Z + pad);
    for (let y = 0; y < src.H * Z; y++) {
      for (let x = 0; x < src.W * Z; x++) {
        const s = (((y / Z) | 0) * src.W + ((x / Z) | 0)) * 4, a = img[s + 3] / 255;
        const d = ((pad + y) * W + left + x) * 4;
        for (let c = 0; c < 3; c++) out[d + c] = Math.round(img[s + c] * a + 238 * (1 - a));
      }
    }
  });
  return encodePng(W, H, out);
}

/** ICO container of PNG entries (Vista+). 256px is encoded as width byte 0. */
function buildIco(pngs) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [], bodies = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); bodies.push(data);
    offset += data.length;
  }
  return Buffer.concat([dir, ...entries, ...bodies]);
}

// ── run ───────────────────────────────────────────────────────────────────
const D = (p) => path.join(ROOT, p);
const wrote = [];
const write = (rel, buf) => {
  fs.mkdirSync(path.dirname(D(rel)), { recursive: true });
  fs.writeFileSync(D(rel), buf);
  wrote.push(`${rel.padEnd(36)} ${(buf.length / 1024).toFixed(1)} KB`);
};

const png = new Map();
const at = (n) => { if (!png.has(n)) png.set(n, encodePng(n, n, rasterise(n, n, 1024 / n))); return png.get(n); };

write('build/icon.svg', Buffer.from(buildSvg()));
write('build/icon.png', at(1024));
write('build/icon.ico', buildIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: at(size) }))));

const setDir = D('build/icon.iconset');
fs.rmSync(setDir, { recursive: true, force: true });
fs.mkdirSync(setDir, { recursive: true });
for (const [name, size] of [
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256],
  ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]
]) {
  fs.writeFileSync(path.join(setDir, `${name}.png`), at(size));
}
execFileSync('iconutil', ['-c', 'icns', setDir, '-o', D('build/icon.icns')]);
fs.rmSync(setDir, { recursive: true, force: true });
wrote.push(`build/icon.icns                      ${(fs.statSync(D('build/icon.icns')).size / 1024).toFixed(1)} KB`);

for (const n of [1024, 128, 32, 16]) write(`logo-preview/council-${n}.png`, at(n));

// The redraw in the source's own frame, and how far it is from the source.
const src = decodePng(fs.readFileSync(D(SOURCE)));
const ours = rasterise(src.W, src.H, K, -SRC.x0 * K, -SRC.y0 * K);
write('logo-preview/council-vs-source-55.png', sideBySide(src, ours));
let err = 0;
for (let i = 0; i < ours.length; i++) err += Math.abs(ours[i] - src.rgba[i]);
wrote.push(`mean abs difference from the source at 55px: ${(err / ours.length).toFixed(2)} / 255 per channel`);

console.log(wrote.join('\n'));
