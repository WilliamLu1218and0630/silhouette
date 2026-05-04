export function drawGoalPreview(canvas, paths) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // ── HiDPI / oversampling ──────────────────────────────────────────────
  // The preview is scaled up to 1.6× on hover/tap (see #goal-canvas:hover
  // and .zoomed in index.html). For pixel-perfect rendering at the zoomed
  // size, the backing buffer must hold at least  cssSize × dpr × zoom
  // device pixels. We add a small headroom (×1.25) so the supersampled
  // downscale also smooths anti-aliasing.
  const cssSize = canvas.clientWidth
               || parseInt(canvas.style.width, 10)
               || canvas.getAttribute('width')
               || 108;
  const dpr     = window.devicePixelRatio || 1;
  const ZOOM    = 1.6;                                     // matches CSS hover scale
  const HEAD    = 1.25;                                    // anti-alias headroom
  // Floor at 4× so non-retina (dpr=1) screens also stay crisp; cap at 8×
  // to keep memory bounded (worst case ≈ 1200²×4 ≈ 5.8 MB).
  const SCALE   = Math.min(8, Math.max(4, Math.ceil(dpr * ZOOM * HEAD)));
  const buf     = Math.round(cssSize * SCALE);
  if (canvas.width !== buf) {
    canvas.width  = buf;
    canvas.height = buf;
    canvas.style.width  = cssSize + 'px';
    canvas.style.height = cssSize + 'px';
  }

  // Draw in logical CSS pixels — the transform handles the upscale.
  const S = cssSize;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);

  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);
  if (!paths || paths.length === 0) return;

  // Collect unique nodes across all paths to compute the bounding box
  const seen = new Set();
  const allNodes = [];
  for (const path of paths) {
    for (const [gx, gz] of path) {
      const k = `${gx},${gz}`;
      if (!seen.has(k)) { seen.add(k); allNodes.push([gx, gz]); }
    }
  }

  const xs   = allNodes.map(p => p[0]);
  const zs   = allNodes.map(p => p[1]);
  const minX = Math.min(...xs), minZ = Math.min(...zs);
  const spanX = Math.max(...xs) - minX;
  const spanZ = Math.max(...zs) - minZ;

  // Fit the goal so that there is roughly 0.7 cells of margin on each side
  // (= "span + 1.4" cells total). Tighter than before so the design feels a
  // bit larger inside the preview. Whichever axis is tighter wins.
  const cell = Math.min(S / (spanX + 1.4), S / (spanZ + 1.4));
  const ox   = (S - cell * spanX) / 2;
  const oz   = (S - cell * spanZ) / 2;

  const toCanvas = (gx, gz) => [ox + (gx - minX) * cell, oz + (gz - minZ) * cell];

  // Grid dots: extend one ring past the bounding box for visual context, but
  // cull any dot whose full radius wouldn't fit inside the canvas — this
  // prevents the half-cut dots that appear flush against the edges.
  const DOT_R = 1.3;
  const gxMin = Math.floor(minX - ox / cell);
  const gxMax = Math.ceil (minX + (S - ox) / cell);
  const gzMin = Math.floor(minZ - oz / cell);
  const gzMax = Math.ceil (minZ + (S - oz) / cell);
  ctx.fillStyle = '#c8c8c0';
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const [px, pz] = toCanvas(gx, gz);
      // Skip dots that would be clipped by the canvas edge
      if (px < DOT_R || px > S - DOT_R || pz < DOT_R || pz > S - DOT_R) continue;
      ctx.beginPath();
      ctx.arc(px, pz, DOT_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth   = 1;
  ctx.lineCap     = 'round';

  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const [gx1, gz1] = path[i];
      const [gx2, gz2] = path[i + 1];
      ctx.beginPath();
      ctx.moveTo(ox + (gx1 - minX) * cell, oz + (gz1 - minZ) * cell);
      ctx.lineTo(ox + (gx2 - minX) * cell, oz + (gz2 - minZ) * cell);
      ctx.stroke();
    }
  }
}
