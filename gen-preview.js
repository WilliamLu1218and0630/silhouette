// Generates preview.png (1200×630) and favicon.png (512×512) from Level 27 goalPaths.
// Run with: node gen-preview.js
const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');

// ── Level 27 goalPaths (used for preview.png) ──────────────────────────────
const goalPaths27 = [
  [[1.7523, 3.3049], [2.5842, 3.4512], [1.4746, 3.8902], [1.4746, 2.9256], [2.0294, 2.7061], [2.8614, 2.8525]],
  [[2.0294, 2.7061], [2.0294, 1.7416], [0.9198, 2.1805], [1.7518, 2.3269], [2.3066, 2.1074], [2.3066, 3.072]],
  [[2.0294, 3.6707], [2.8614, 3.8171], [2.3066, 4.0366], [3.1386, 4.1829], [3.1386, 3.2184], [3.6934, 2.9989], [3.6934, 3.9634]],
  [[1.7518, 2.3269], [1.7518, 3.2915], [2.5838, 3.4378], [3.1386, 3.2184]],
];

// ── Level 14 goalPaths (used for favicon.png) ──────────────────────────────
const goalPaths14 = [
  [[2.2929, 3.8165], [2.2929, 3], [1.5858, 2.5918], [2.2929, 2.1835], [2.2929, 1.367]],
  [[1.5858, 2.5918], [1.5858, 3.4082], [2.2929, 3.8165], [2.2929, 3]],
  [[2.2929, 3.8165], [3, 3.4082], [3.7071, 3.8165], [3.7071, 3], [3, 2.5918], [3, 3.4082]],
  [[3.7071, 3.8165], [4.4142, 3.4082], [4.4142, 2.5918], [3.7071, 3], [4.4142, 2.5918], [3.7071, 2.1835], [3, 2.5918]],
  [[3, 1.7753], [3.7071, 1.367], [3, 0.9588], [2.2929, 1.367], [3, 1.7753]],
  [[2.2929, 3], [3, 2.5918], [2.2929, 2.1835], [3, 2.5918], [3, 1.7753]],
  [[3.7071, 2.1835], [3.7071, 1.367]],
];

// ── Design tokens ──────────────────────────────────────────────────────────
const BG   = [245, 245, 240]; // #f5f5f0
const LINE = [26,  26,  46 ]; // #1a1a2e
const DOT  = [200, 200, 192]; // #c8c8c0

// ── Renderer ───────────────────────────────────────────────────────────────
function renderImage(W, H, goalPaths, fitFraction, lineScale) {
  const seen = new Set(), allNodes = [];
  for (const p of goalPaths)
    for (const [gx, gz] of p) {
      const k = `${gx},${gz}`;
      if (!seen.has(k)) { seen.add(k); allNodes.push([gx, gz]); }
    }
  const xs = allNodes.map(p => p[0]), zs = allNodes.map(p => p[1]);
  const minX = Math.min(...xs), minZ = Math.min(...zs);
  const spanX = Math.max(...xs) - minX, spanZ = Math.max(...zs) - minZ;
  const pixels = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    pixels[i*3]   = BG[0];
    pixels[i*3+1] = BG[1];
    pixels[i*3+2] = BG[2];
  }

  function blendPixel(x, y, r, g, b, alpha) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= W || y < 0 || y >= H || alpha <= 0) return;
    const i = (y * W + x) * 3;
    const a = Math.min(1, alpha);
    pixels[i]   = Math.round(pixels[i]   * (1-a) + r * a);
    pixels[i+1] = Math.round(pixels[i+1] * (1-a) + g * a);
    pixels[i+2] = Math.round(pixels[i+2] * (1-a) + b * a);
  }

  function drawCircle(cx, cy, radius, r, g, b) {
    const ir = Math.ceil(radius + 1.5);
    for (let dy = -ir; dy <= ir; dy++)
      for (let dx = -ir; dx <= ir; dx++) {
        const alpha = Math.max(0, Math.min(1, radius + 0.5 - Math.sqrt(dx*dx + dy*dy)));
        if (alpha > 0) blendPixel(Math.floor(cx)+dx, Math.floor(cy)+dy, r, g, b, alpha);
      }
  }

  function drawLine(x0, y0, x1, y1, r, g, b, width) {
    const dx = x1-x0, dy = y1-y0;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 0.001) { drawCircle(x0, y0, width/2, r, g, b); return; }
    const steps = Math.ceil(len) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      drawCircle(x0 + t*dx, y0 + t*dy, width/2, r, g, b);
    }
  }

  const S    = Math.min(W, H) * fitFraction;
  const cell = Math.min(S / (spanX + 1.4), S / (spanZ + 1.4));
  const ox   = (W - cell * spanX) / 2 - minX * cell;
  const oz   = (H - cell * spanZ) / 2 - minZ * cell;
  const toC  = (gx, gz) => [ox + gx * cell, oz + gz * cell];

  const LINE_W = Math.max(2, cell * (lineScale || 0.037));
  const DOT_R  = Math.max(1.5, cell * 0.022);

  // grid dots
  const gxMin = Math.floor(minX - 0.7), gxMax = Math.ceil(minX + spanX + 0.7);
  const gzMin = Math.floor(minZ - 0.7), gzMax = Math.ceil(minZ + spanZ + 0.7);
  for (let gx = gxMin; gx <= gxMax; gx++)
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const [px, pz] = toC(gx, gz);
      if (px > DOT_R && px < W-DOT_R && pz > DOT_R && pz < H-DOT_R)
        drawCircle(px, pz, DOT_R, DOT[0], DOT[1], DOT[2]);
    }

  // goal lines
  for (const p of goalPaths)
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = toC(...p[i]);
      const [x1, y1] = toC(...p[i+1]);
      drawLine(x0, y0, x1, y1, LINE[0], LINE[1], LINE[2], LINE_W);
    }

  return pixels;
}

// ── PNG encoder ────────────────────────────────────────────────────────────
function encodePNG(W, H, pixels) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W*3+1)] = 0;
    for (let x = 0; x < W; x++) {
      const si = y*(W*3+1) + 1 + x*3;
      const pi = (y*W+x)*3;
      raw[si] = pixels[pi]; raw[si+1] = pixels[pi+1]; raw[si+2] = pixels[pi+2];
    }
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write files ────────────────────────────────────────────────────────────
// preview.png is generated via preview-gen.html (browser canvas, includes text overlay)
const previewPng = encodePNG(1200, 630, renderImage(1200, 630, goalPaths14, 0.78));
fs.writeFileSync(path.join(__dirname, 'preview.png'), previewPng);
console.log(`preview.png  ${previewPng.length} bytes`);

const faviconPng = encodePNG(512, 512, renderImage(512, 512, goalPaths14, 0.94, 0.052));
fs.writeFileSync(path.join(__dirname, 'favicon.png'), faviconPng);
console.log(`favicon.png  ${faviconPng.length} bytes`);
