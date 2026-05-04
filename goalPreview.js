export function drawGoalPreview(canvas, paths) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const S   = canvas.width || 108;

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

  // Fit the goal so that there is exactly one cell of margin on each side
  // (= "spanX + 2" cells of total width). Whichever axis is tighter wins; the
  // looser axis just gets more margin.
  const cell = Math.min(S / (spanX + 2), S / (spanZ + 2));
  const ox   = (S - cell * spanX) / 2;
  const oz   = (S - cell * spanZ) / 2;

  const toCanvas = (gx, gz) => [ox + (gx - minX) * cell, oz + (gz - minZ) * cell];

  // Grid dots: outset enough to fill the whole canvas (compute integer-coord
  // range that spans canvas pixel 0..S). Draw before lines so lines win.
  const gxMin = Math.floor(minX - ox / cell);
  const gxMax = Math.ceil (minX + (S - ox) / cell);
  const gzMin = Math.floor(minZ - oz / cell);
  const gzMax = Math.ceil (minZ + (S - oz) / cell);
  ctx.fillStyle = '#c8c8c0';
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const [px, pz] = toCanvas(gx, gz);
      ctx.beginPath();
      ctx.arc(px, pz, 1.3, 0, Math.PI * 2);
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
