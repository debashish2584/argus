#!/usr/bin/env node
/**
 * Generates the Argus Studio PWA icons (web/icons/icon-192.png, icon-512.png).
 *
 * Zero dependencies: a minimal RGBA PNG encoder (node:zlib for IDAT) plus a
 * small rasterizer that draws the same "all-seeing eye" mark as web/favicon.svg
 * (supersampled + box-downsampled for clean edges). Run from the package root:
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* PNG encoding                                                        */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* the mark — same geometry as web/favicon.svg                         */
/* ------------------------------------------------------------------ */

const C = {
  bg: [11, 15, 20], // #0b0f14
  bgEdge: [19, 25, 32], // subtle inner edge
  amber: [242, 182, 75], // #f2b64b
  teal: [86, 179, 196], // #56b3c4
  ink: [16, 23, 32], // #101720 (iris ground)
};

/**
 * Paint one supersample pixel into `px` (RGBA, row-major, premultiplied-free).
 * All coordinates are normalized to [0,1] × [0,1].
 */
function paint(u, v, out) {
  // rounded-square background
  const r = 0.2;
  const inRect = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  if (!inRect) {
    out[3] = 0;
    return;
  }
  const dx = Math.min(Math.max(u, r), 1 - r) - u;
  const dy = Math.min(Math.max(v, r), 1 - r) - v;
  const cornerDist = Math.hypot(dx, dy);
  if (dx < 0 && dy < 0 && cornerDist > r) {
    out[3] = 0;
    return;
  }
  set(out, C.bg);
  // subtle inner edge (1-unit inset) so the tile reads on any dock
  const inset = 0.004;
  const nearEdge = u < inset || u > 1 - inset || v < inset || v > 1 - inset;
  if (nearEdge && out[3] === 255) blend(out, C.bgEdge, 0.5);

  // eye: pointed-ellipse (parabolic) lens, centered at (0.5, 0.54)
  const cx = 0.5, cy = 0.54, a = 0.4, b = 0.27, stroke = 0.03;
  const ex = (u - cx) / a;
  const inLens = Math.abs(ex) <= 1;
  if (inLens) {
    const h = b * (1 - ex * ex);
    const d = Math.abs(v - cy) - h; // < 0 inside
    if (d < -stroke / 2) {
      set(out, C.ink); // eye ground
      // iris rings
      const ir = Math.hypot(u - cx, v - cy);
      if (ir <= 0.19) {
        if (Math.abs(ir - 0.165) < 0.02) set(out, C.amber);
        else if (Math.abs(ir - 0.12) < 0.015) set(out, C.teal);
        else if (ir <= 0.065) set(out, C.amber); // pupil
      }
    } else if (d < stroke / 2) {
      set(out, C.amber); // lens stroke
    }
  }
  // all-seeing satellites (three "other eyes") arced above the mark
  const dots = [
    [0.24, 0.17],
    [0.5, 0.105],
    [0.76, 0.17],
  ];
  for (const [du, dv] of dots) {
    if (Math.hypot(u - du, v - dv) < 0.03) {
      if (Math.hypot(u - du, v - dv) < 0.014) set(out, C.amber);
      else set(out, C.teal);
    }
  }
}

function set(out, c) {
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  out[3] = 255;
}

function blend(out, c, t) {
  out[0] = out[0] * (1 - t) + c[0] * t;
  out[1] = out[1] * (1 - t) + c[1] * t;
  out[2] = out[2] * (1 - t) + c[2] * t;
}

function render(size, ss) {
  const W = size * ss;
  const big = new Float64Array(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const out = [0, 0, 0, 0];
      paint((x + 0.5) / W, (y + 0.5) / W, out);
      const i = (y * W + x) * 4;
      big[i] = out[0];
      big[i + 1] = out[1];
      big[i + 2] = out[2];
      big[i + 3] = out[3];
    }
  }
  // box downsample
  const rgba = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const k = ((y * ss + j) * W + (x * ss + i)) * 4;
          r += big[k];
          g += big[k + 1];
          b += big[k + 2];
          a += big[k + 3];
        }
      }
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

const outDir = path.resolve(import.meta.dirname, "..", "web", "icons");
mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, size, render(size, 3)));
  console.log(`✓ ${file}`);
}
