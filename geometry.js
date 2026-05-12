// Shared geometric constants and pure 2-D matching functions.
// Used by both threeGame.js (browser) and solver/verifier.mjs (Node.js).
// Keep free of Three.js and DOM dependencies.

export const CELL                    = 0.5;
export const GEO_EPSILON             = 0.12;
export const GEO_SAMPLE_STEP         = 0.05;
export const GEO_MIN_SEGMENT_COVERAGE = 0.95;
export const GEO_MIN_SAMPLES_PER_SEG  = 21;

// Translate a 2-D shape so its bounding-box centre sits at the origin.
// Scale is preserved (no normalisation to [0,1]).
export function centerShape(segments, extraPoints) {
  if (!segments || !segments.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [s, e] of segments) {
    for (const p of [s, e]) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const shift = ([x, y]) => [x - cx, y - cy];
  return {
    segments: segments.map(([s, e]) => [shift(s), shift(e)]),
    points:   extraPoints ? extraPoints.map(shift) : [],
  };
}

export function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = x1 + t * dx, qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function distPointToShape(px, py, segs) {
  let best = Infinity;
  for (const [s, e] of segs) {
    const d = distPointToSegment(px, py, s[0], s[1], e[0], e[1]);
    if (d < best) best = d;
  }
  return best;
}

// Always includes both endpoints; minN enforces size-independent stringency.
export function sampleSegment(s, e, step, minN = 2) {
  const len = Math.hypot(e[0] - s[0], e[1] - s[1]);
  const n = Math.max(minN, Math.ceil(len / step) + 1);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = [s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1])];
  }
  return out;
}

// Per-segment (not global-average) coverage check.
// Each segment of both the goal and rod projection must reach GEO_MIN_SEGMENT_COVERAGE
// individually, so a single misplaced stroke cannot be hidden by the others.
export function measureGeometricMatch(rodShape, goalShape) {
  if (!rodShape || !goalShape) {
    return { matched: false, rodCoverage: 0, goalCoverage: 0 };
  }
  const rodSegs  = rodShape.segments;
  const goalSegs = goalShape.segments;
  if (rodSegs.length === 0 || goalSegs.length === 0) {
    return { matched: false, rodCoverage: 0, goalCoverage: 0 };
  }

  let minGoalSegCov = 1;
  for (const [s, e] of goalSegs) {
    const pts = sampleSegment(s, e, GEO_SAMPLE_STEP, GEO_MIN_SAMPLES_PER_SEG);
    let covered = 0;
    for (const [px, py] of pts) {
      if (distPointToShape(px, py, rodSegs) <= GEO_EPSILON) covered++;
    }
    const cov = covered / pts.length;
    if (cov < minGoalSegCov) minGoalSegCov = cov;
  }

  let minRodSegCov = 1;
  for (const [s, e] of rodSegs) {
    const pts = sampleSegment(s, e, GEO_SAMPLE_STEP, GEO_MIN_SAMPLES_PER_SEG);
    let covered = 0;
    for (const [px, py] of pts) {
      if (distPointToShape(px, py, goalSegs) <= GEO_EPSILON) covered++;
    }
    const cov = covered / pts.length;
    if (cov < minRodSegCov) minRodSegCov = cov;
  }

  const matched = minGoalSegCov >= GEO_MIN_SEGMENT_COVERAGE
               && minRodSegCov  >= GEO_MIN_SEGMENT_COVERAGE;

  return { matched, goalCoverage: minGoalSegCov, rodCoverage: minRodSegCov };
}
