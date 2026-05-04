import { LEVELS, scrambleLevel } from './levels.js';
import { drawGoalPreview } from './goalPreview.js';

// ── Editor test-level injection ──────────────────────────────────────────────
// level-editor.html writes a level to sessionStorage before opening this page.
let _editorTestMode = false;
{
  const _raw = sessionStorage.getItem('silhouette-test-level');
  if (_raw) {
    try { LEVELS.unshift(JSON.parse(_raw)); _editorTestMode = true; } catch {}
    sessionStorage.removeItem('silhouette-test-level');
  }
}

export function initGame() {
  'use strict';

  // ── Camera ──────────────────────────────────────────────────────────────────
  const CAM_SIZE          = 5;                           // orthographic frustum half-size
  const CAM_DIST          = 16;                          // orbit radius from origin
  const CAM_ZOOM_INIT     = 2.0;                         // zoom level at startup
  const CAM_ZOOM_LOAD     = 1.5;                         // zoom reset on every level load
  const ZOOM_MIN          = 0.3;                         // minimum zoom
  const ZOOM_MAX          = 3.0;                         // maximum zoom
  const CAM_THETA_DEFAULT = Math.PI / 4;                 // default horizontal angle (45°)
  const CAM_PHI_DEFAULT   = Math.atan(1 / Math.sqrt(2)); // default elevation (~35°, isometric)
  const CAM_PHI_MAX       = Math.PI / 2 - 0.01;         // elevation upper clamp
  const CAM_PHI_MIN       = -Math.PI / 2 + 0.01;        // elevation lower clamp

  // ── Rod geometry ────────────────────────────────────────────────────────────
  const CELL  = 0.5;       // world units per grid cell
  const ROD_R = 0.010;     // rod cylinder radius
  const ROD_Y = ROD_R / 2; // Y offset so rods sit flush above y = 0
  const HIT_R = 0.32;      // invisible hit-detection cylinder radius (larger than visual)

  // ── Rod colours ─────────────────────────────────────────────────────────────
  const COL_IDLE  = new THREE.Color(0x1a1a2e); // default rod colour
  const COL_HOVER = new THREE.Color(0x4a4a6e); // hover affordance (lighter than idle)
  const COL_DRAG  = new THREE.Color(0xe94560); // active-drag / level-clear flash colour

  // ── Victory detection (geometric segment coverage) ─────────────────────────
  // Compares projected rod segments to goal segments directly, in world units,
  // after translating each shape's bbox-center to the origin (no rescale: scale
  // matches naturally because goal coords get multiplied by CELL).
  const GEO_EPSILON       = 0.12;  // matching tolerance, world units (~0.24 grid cell)
  const GEO_SAMPLE_STEP   = 0.05;  // segment sampling step ≤ ε/2
  const GEO_MIN_COVERAGE  = 0.97;  // bidirectional coverage required (rod↔goal)
  const GEO_JUNCTION_EPS  = 0.18;  // corner-snap tolerance, world units (~0.36 cell)

  // ── Interaction ─────────────────────────────────────────────────────────────
  // Pointer travel (px) needed to commit a drag. Touch input is noisier than
  // mouse, so coarse pointers get a larger threshold to avoid accidental rod-grabs
  // when the user means to rotate the camera.
  const DRAG_THRESH_MOUSE = 5;
  const DRAG_THRESH_TOUCH = 9;
  const _coarsePointer = (typeof matchMedia === 'function')
    ? matchMedia('(pointer: coarse)').matches : false;
  let DRAG_THRESH = _coarsePointer ? DRAG_THRESH_TOUCH : DRAG_THRESH_MOUSE;
  const VICTORY_IMMUNE_MS = 1200; // grace period (ms) after level load before victory check
  // Magnetic-snap drag tuning (see magnetize()): values are in fractions of one cell.
  const SNAP_BUFFER       = 0.32; // |delta| within this fraction of a cell → full snap (容錯緩衝)
  const SNAP_RANGE_END    = 0.5;  // beyond this fraction the rod follows the cursor 1:1
  const SNAP_VIBRATE_MS   = 8;    // duration (ms) for tiny haptic blip when snapping to a new cell
  const EDGE_OVERSHOOT_MAX = 0.35; // max cells the rod can rubber-band past the grid edge

  // ── Progress persistence ─────────────────────────────────────────────────────
  const STORAGE_KEY = 'silhouette-progress'; // localStorage key

  // ── Renderer / scene setup ──────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);

  function resizeCanvasWrap() {
    const wrap = document.getElementById('game-canvas-wrap');
    if (!wrap) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    wrap.style.width     = w + 'px';
    wrap.style.height    = h + 'px';
    wrap.style.position  = 'absolute';
    wrap.style.left      = '0';
    wrap.style.top       = '50px';
    wrap.style.transform = 'none';
    wrap.style.zIndex    = '1';
    renderer.setSize(w, h);
  }
  resizeCanvasWrap();
  renderer.setClearColor(0xf5f5f0);
  renderer.shadowMap.enabled = true;
  document.getElementById('game-canvas-wrap').appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, {
    position: 'absolute', inset: '0',
    width: '100%', height: '100%',
    zIndex: '1', touchAction: 'none',
  });

  const scene = new THREE.Scene();

  let camAspect = window.innerWidth / window.innerHeight;
  const camera = new THREE.OrthographicCamera(
    -CAM_SIZE * camAspect,  CAM_SIZE * camAspect,
     CAM_SIZE,             -CAM_SIZE,
    0.1, 120
  );

  let camZoomFactor = CAM_ZOOM_INIT;

  function applyZoom() {
    camera.left   = -CAM_SIZE * camAspect / camZoomFactor;
    camera.right  =  CAM_SIZE * camAspect / camZoomFactor;
    camera.top    =  CAM_SIZE / camZoomFactor;
    camera.bottom = -CAM_SIZE / camZoomFactor;
    camera.updateProjectionMatrix();
  }

  const _camViewDir = new THREE.Vector3();
  const _camRight   = new THREE.Vector3();
  const camOrbit    = new THREE.Vector3();
  const camUp       = new THREE.Vector3(0, 1, 0);
  let camTheta = CAM_THETA_DEFAULT;
  let camPhi   = CAM_PHI_DEFAULT;

  function setCameraOrbit(theta, phi) {
    camOrbit.set(
      Math.cos(phi) * Math.sin(theta),
      Math.sin(phi),
      Math.cos(phi) * Math.cos(theta)
    ).setLength(CAM_DIST);
    // Phi tangent direction as up: stable at all elevations (including near-pole) without drift
    camUp.set(
      -Math.sin(phi) * Math.sin(theta),
       Math.cos(phi),
      -Math.sin(phi) * Math.cos(theta)
    );
  }

  function resetCameraOrbit() {
    camTheta = CAM_THETA_DEFAULT;
    camPhi   = CAM_PHI_DEFAULT;
    setCameraOrbit(camTheta, camPhi);
  }

  function normalizeCameraOrientation() {
    camOrbit.setLength(CAM_DIST);
    _camViewDir.copy(camOrbit).normalize().negate();
    _camRight.crossVectors(_camViewDir, camUp).normalize();
  }

  function updateCamera() {
    normalizeCameraOrientation();
    camera.position.copy(camOrbit);
    camera.up.copy(camUp);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  resetCameraOrbit();
  updateCamera();

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.5);
  sun.position.set(8, 14, 8);
  sun.castShadow = true;
  scene.add(sun);

  const floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  floorMesh.rotation.x = -Math.PI / 2;
  scene.add(floorMesh);

  let rods = [];
  let gridSize = 5;
  let goalSegments = [];
  let goalShape = null;
  let lastProjectionStats = null;
  let completedLevels = new Set();
  let currentLevel    = 0;
  let levelPage       = 0;
  let cleared = false;
  // Undo history: each entry is a snapshot of all rod paths at a prior committed state.
  // Only filled by completed drags (not mid-drag), and cleared on level (re)load.
  let undoStack = [];

  function snapshotRods() {
    return rods.map(r => r.path.map(n => [...n]));
  }
  function pushUndoSnapshot(snap) {
    undoStack.push(snap);
    if (undoStack.length > 50) undoStack.shift();
    updateUndoBtn();
  }
  function updateUndoBtn() {
    const btn = document.getElementById('undo-btn');
    if (btn) btn.disabled = undoStack.length === 0;
  }
  function applySnapshot(snap, animate) {
    if (!snap || snap.length !== rods.length) return;
    for (let i = 0; i < rods.length; i++) {
      rods[i].path = snap[i].map(n => [...n]);
      updateRodMeshPositions(rods[i], animate, 0.22);
    }
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.completed)) data.completed.forEach(i => completedLevels.add(i));
      if (typeof data.current === 'number') currentLevel = Math.min(data.current, LEVELS.length - 1);
    } catch {} // ignore parse errors or unavailable storage (e.g. private mode)
  }

  function updateHomeProgress() {
    const el = document.getElementById('home-progress');
    if (!el) return;
    el.textContent = `${completedLevels.size} / ${LEVELS.length}`;
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        completed: [...completedLevels],
        current:   currentLevel,
      }));
    } catch {}
    updateHomeProgress();
  }

  loadProgress();
  updateHomeProgress();
  let victoryImmune = false;
  let clearTimer = null;
  let sceneObjects = [];

  function cellToWorld(gx, gz) {
    const off = (gridSize - 1) / 2;
    return new THREE.Vector3((gx - off) * CELL, ROD_Y, (gz - off) * CELL);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // node = [gx, gy, gz] (3D grid coords)
  function nodeToWorld(node) {
    const [gx, gy, gz] = node;
    const off = (gridSize - 1) / 2;
    return new THREE.Vector3((gx - off) * CELL, ROD_Y + gy * CELL, (gz - off) * CELL);
  }

  // Rotate a CylinderGeometry mesh (default Y axis) to align its axis with dir
  function orientMeshAlongDir(mesh, dir) {
    const up = new THREE.Vector3(0, 1, 0);
    const targetDir = dir.clone().normalize();
    if (Math.abs(targetDir.dot(up)) > 0.999) {
      mesh.rotation.set(0, 0, 0);
      if (targetDir.y < 0) mesh.rotateX(Math.PI);
    } else {
      mesh.setRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, targetDir));
    }
  }

  function clearScene() {
    sceneObjects.forEach(o => scene.remove(o));
    sceneObjects = [];
    rods = [];
    cleared = false;
    victoryImmune = false;
    goalShape = null;
    lastProjectionStats = null;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  }

  function addToScene(obj) {
    scene.add(obj);
    sceneObjects.push(obj);
    return obj;
  }

  function buildGridDots() {
    const geo = new THREE.SphereGeometry(0.015, 6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xc8c8c0 });
    for (let x = 0; x < gridSize; x++) {
      for (let z = 0; z < gridSize; z++) {
        const m = new THREE.Mesh(geo, mat);
        const p = cellToWorld(x, z);
        m.position.set(p.x, 0.01, p.z);
        addToScene(m);
      }
    }
  }

  function buildSegmentsFromPaths(paths) {
    if (!paths || paths.length === 0) return [];
    const segments = [];
    for (const path of paths) {
      for (let i = 0; i < path.length - 1; i++) {
        const [x1, z1] = path[i];
        const [x2, z2] = path[i + 1];
        segments.push({ x1, z1, x2, z2 });
      }
    }
    return segments;
  }

  function updateRodMeshPositions(rod, animate, duration = 0.20) {
    for (let i = 0; i < rod.path.length - 1; i++) {
      const p1 = nodeToWorld(rod.path[i]);
      const p2 = nodeToWorld(rod.path[i + 1]);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2, mz = (p1.z + p2.z) / 2;
      const seg = rod.segMeshes[i], hit = rod.hitMeshes[i];
      if (animate) {
        gsap.to(seg.position, { x: mx, y: my, z: mz, duration, ease: 'power2.out', overwrite: 'auto' });
        gsap.to(hit.position, { x: mx, y: my, z: mz, duration, overwrite: 'auto' });
      } else {
        seg.position.set(mx, my, mz);
        hit.position.set(mx, my, mz);
      }
    }
    for (let i = 0; i < rod.jointMeshes.length; i++) {
      const p = nodeToWorld(rod.path[i + 1]);
      const jm = rod.jointMeshes[i];
      if (animate) {
        gsap.to(jm.position, { x: p.x, y: p.y, z: p.z, duration, ease: 'power2.out', overwrite: 'auto' });
      } else {
        jm.position.set(p.x, p.y, p.z);
      }
    }
  }

  function makeRod(data) {
    // Path formats: [[gx, gz], ...] or [[gx, gy, gz], ...]
    // Legacy endpoint format (gx1/gz1/gx2/gz2) auto-converts to a 2-node path
    let rawPath;
    if (data.path) {
      rawPath = data.path;
    } else {
      const gx1 = data.gx1 ?? data.gx ?? 0;
      const gz1 = data.gz1 ?? data.gz ?? 0;
      rawPath = [[gx1, gz1], [data.gx2 ?? (gx1 + 1), data.gz2 ?? gz1]];
    }

    // Normalise to 3-D nodes [gx, gy, gz]; gy defaults to 0 for 2-D input
    const path = rawPath.map(n => n.length === 3 ? [...n] : [n[0], 0, n[1]]);

    const baseMat = new THREE.MeshStandardMaterial({
      color: COL_IDLE.clone(),
      roughness: 0.35,
      metalness: 0.08,
    });

    const segMeshes = [], hitMeshes = [], jointMeshes = [];

    for (let i = 0; i < path.length - 1; i++) {
      const p1 = nodeToWorld(path[i]);
      const p2 = nodeToWorld(path[i + 1]);
      const dir = new THREE.Vector3().subVectors(p2, p1);
      const len = dir.length() || CELL * 0.01;

      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(ROD_R, ROD_R, len, 14),
        baseMat.clone()
      );
      mesh.castShadow = true;
      orientMeshAlongDir(mesh, dir);
      mesh.position.lerpVectors(p1, p2, 0.5);
      addToScene(mesh);
      segMeshes.push(mesh);

      // Hit mesh is larger than visual mesh for easier selection
      const hitMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(HIT_R * 1.4, HIT_R * 1.4, len * 1.5, 10),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      orientMeshAlongDir(hitMesh, dir);
      hitMesh.position.copy(mesh.position);
      addToScene(hitMesh);
      hitMeshes.push(hitMesh);
    }

    // Intermediate nodes get sphere joints to fill visual gaps
    for (let i = 1; i < path.length - 1; i++) {
      const jm = new THREE.Mesh(
        new THREE.SphereGeometry(ROD_R * 1.15, 10, 10),
        baseMat.clone()
      );
      jm.position.copy(nodeToWorld(path[i]));
      addToScene(jm);
      jointMeshes.push(jm);
    }

    return {
      id: data.id,
      path,
      segMeshes,
      hitMeshes,
      jointMeshes,
      allMeshes: [...segMeshes, ...jointMeshes],
    };
  }

  // Per-load seed so each entry into a level scrambles rods differently. Reset
  // button reuses the same seed; navigating away and re-entering generates fresh.
  let activeScramble = null;  // { idx, seed }

  function loadLevel(idx, opts = {}) {
    clearScene();
    undoStack = [];
    updateUndoBtn();
    const _almost = document.getElementById('almost-hint');
    if (_almost) _almost.classList.remove('visible');
    saveProgress();
    hideOverlay('clear-overlay');
    if (opts.preserveSeed && activeScramble && activeScramble.idx === idx) {
      // reuse existing seed (Reset button)
    } else {
      activeScramble = { idx, seed: (Math.random() * 0x7fffffff) | 0 };
    }
    const lvl = scrambleLevel(LEVELS[idx], activeScramble.seed);
    gridSize = lvl.grid;
    // Scale default zoom inversely with grid size so larger grids render
    // smaller and the rod cluster doesn't overlap the goal-preview overlay.
    camZoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, CAM_ZOOM_LOAD * (5 / Math.max(gridSize, 1))));
    applyZoom();
    goalSegments = buildSegmentsFromPaths(lvl.goalPaths);

    document.getElementById('lvl-num').textContent = idx + 1;
    buildGridDots();
    floatGrid.clear();
    lvl.rods.forEach(r => rods.push(makeRod(r)));
    drawGoalPreview(document.getElementById('goal-canvas'), lvl.goalPaths);
    goalShape = buildGoalShapeData();
    lastProjectionStats = null;
    updateDebugPanel();

    resetCameraOrbit();
    updateCamera();

    victoryImmune = true;
    setTimeout(() => { victoryImmune = false; }, VICTORY_IMMUNE_MS);
  }

  // Project a world position onto the camera's view plane.
  // Uses dot products with camera right/up vectors to avoid NDC aspect-ratio distortion.
  function projectToView(worldPos) {
    return [worldPos.dot(_camRight), worldPos.dot(camUp)];
  }

  // Translate a shape so its bbox-center sits at the origin. Scale is preserved
  // (no normalization to [0,1]) — for the rod projection that's already world
  // units, and for the goal we multiply by CELL upstream.
  function centerShape(segments, extraPoints) {
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

  function distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = x1 + t * dx, qy = y1 + t * dy;
    return Math.hypot(px - qx, py - qy);
  }

  function distPointToShape(px, py, segs) {
    let best = Infinity;
    for (const [s, e] of segs) {
      const d = distPointToSegment(px, py, s[0], s[1], e[0], e[1]);
      if (d < best) best = d;
    }
    return best;
  }

  // Sample a segment at intervals ≤ step (always includes both endpoints).
  function sampleSegment(s, e, step) {
    const len = Math.hypot(e[0] - s[0], e[1] - s[1]);
    const n = Math.max(2, Math.ceil(len / step) + 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      out[i] = [s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1])];
    }
    return out;
  }

  function measureGeometricMatch(rodShape, goalShape) {
    if (!rodShape || !goalShape) {
      return { matched: false, rodCoverage: 0, goalCoverage: 0, junctionsHit: 0, junctionsTotal: 0 };
    }
    const rodSegs  = rodShape.segments;
    const goalSegs = goalShape.segments;
    const junctions = goalShape.points;

    let goalSamples = 0, goalCovered = 0;
    for (const [s, e] of goalSegs) {
      const pts = sampleSegment(s, e, GEO_SAMPLE_STEP);
      for (const [px, py] of pts) {
        goalSamples++;
        if (distPointToShape(px, py, rodSegs) <= GEO_EPSILON) goalCovered++;
      }
    }

    let rodSamples = 0, rodCovered = 0;
    for (const [s, e] of rodSegs) {
      const pts = sampleSegment(s, e, GEO_SAMPLE_STEP);
      for (const [px, py] of pts) {
        rodSamples++;
        if (distPointToShape(px, py, goalSegs) <= GEO_EPSILON) rodCovered++;
      }
    }

    let junctionsHit = 0;
    for (const [jx, jy] of junctions) {
      let hit = false;
      for (const [px, py] of rodShape.points) {
        if (Math.hypot(jx - px, jy - py) <= GEO_JUNCTION_EPS) { hit = true; break; }
      }
      if (hit) junctionsHit++;
    }

    const goalCoverage = goalSamples > 0 ? goalCovered / goalSamples : 0;
    const rodCoverage  = rodSamples  > 0 ? rodCovered  / rodSamples  : 0;
    const junctionsOK  = junctionsHit === junctions.length;

    return {
      matched: goalCoverage >= GEO_MIN_COVERAGE && rodCoverage >= GEO_MIN_COVERAGE && junctionsOK,
      goalCoverage, rodCoverage,
      junctionsHit, junctionsTotal: junctions.length,
    };
  }

  function drawShapeOverlay(canvas, primary, ghost) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    const allSegs = [
      ...((primary && primary.segments) || []),
      ...((ghost   && ghost.segments)   || []),
    ];
    if (!allSegs.length) return;
    const grid = (goalShape && goalShape.gridDots) || [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [s, e] of allSegs) {
      for (const p of [s, e]) {
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      }
    }
    // Include grid dots in the bbox so the outermost dots stay inside the canvas.
    for (const [x, y] of grid) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const pad = 8;
    const scale = (Math.min(W, H) - pad * 2) / span;
    const toCanvas = ([x, y]) => [W / 2 + x * scale, H / 2 + y * scale];

    // Grid dots first, so segments draw on top.
    if (grid.length) {
      ctx.fillStyle = '#c8c8c0';
      for (const [x, y] of grid) {
        const [px, py] = toCanvas([x, y]);
        ctx.beginPath();
        ctx.arc(px, py, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (ghost) {
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      for (const [s, e] of ghost.segments) {
        const [x1, y1] = toCanvas(s);
        const [x2, y2] = toCanvas(e);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (primary) {
      ctx.strokeStyle = '#1a1a2e';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [s, e] of primary.segments) {
        const [x1, y1] = toCanvas(s);
        const [x2, y2] = toCanvas(e);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.stroke();

      // junction dots
      if (primary.points && primary.points.length) {
        ctx.fillStyle = '#e94560';
        for (const [x, y] of primary.points) {
          const [cx, cy] = toCanvas([x, y]);
          ctx.beginPath();
          ctx.arc(cx, cy, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function updateDebugPanel() {
    const goalCanvas = document.getElementById('debug-goal-canvas');
    const rodCanvas  = document.getElementById('debug-rod-canvas');
    const stats      = document.getElementById('debug-stats');
    if (!stats) return;

    drawShapeOverlay(goalCanvas, goalShape, null);
    const rodShape = lastProjectionStats && lastProjectionStats.rodShape;
    drawShapeOverlay(rodCanvas, rodShape, goalShape);

    if (!goalShape)            { stats.textContent = 'Waiting for level...'; return; }
    if (!lastProjectionStats)  { stats.textContent = 'Move a line or rotate the camera to evaluate.'; return; }

    const { rodCoverage, goalCoverage, junctionsHit, junctionsTotal, matched } = lastProjectionStats;
    stats.textContent =
      `matched: ${matched}\n` +
      `goal cov: ${goalCoverage.toFixed(3)}  (≥ ${GEO_MIN_COVERAGE})\n` +
      `rod  cov: ${rodCoverage.toFixed(3)}\n` +
      `corners: ${junctionsHit}/${junctionsTotal}`;
  }

  function buildProjectedRodShape() {
    const segments = [], endpoints = [];
    for (const rod of rods) {
      const projected = rod.path.map(n => {
        const w = nodeToWorld(n);
        const [px, py] = projectToView(w);
        return [px, -py];
      });
      for (let i = 0; i < projected.length - 1; i++) {
        segments.push([projected[i], projected[i + 1]]);
      }
      // First and last node of the path are the rod's endpoints; intermediate
      // nodes are corners. Treat all of them as candidate "junction-snap" points.
      for (const p of projected) endpoints.push(p);
    }
    return centerShape(segments, endpoints);
  }

  function buildGoalShapeData() {
    if (!goalSegments.length) return null;
    const segments = goalSegments.map(s => [
      [s.x1 * CELL, s.z1 * CELL],
      [s.x2 * CELL, s.z2 * CELL],
    ]);
    // Junctions = every distinct goal node (endpoints + path-corners).
    // Track integer goal-coord bbox while we're at it for grid-dot generation.
    const seen = new Set();
    const junctions = [];
    let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
    for (const { x1, z1, x2, z2 } of goalSegments) {
      for (const [x, z] of [[x1, z1], [x2, z2]]) {
        if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x;
        if (z < gMinY) gMinY = z; if (z > gMaxY) gMaxY = z;
        const key = `${x},${z}`;
        if (!seen.has(key)) { seen.add(key); junctions.push([x * CELL, z * CELL]); }
      }
    }
    // Grid dots: integer goal coords from bbox outset by 1 cell, in world units.
    const gridDots = [];
    for (let gx = gMinX - 1; gx <= gMaxX + 1; gx++) {
      for (let gy = gMinY - 1; gy <= gMaxY + 1; gy++) {
        gridDots.push([gx * CELL, gy * CELL]);
      }
    }
    // Apply the same bbox-center shift centerShape() would, uniformly to all
    // three lists so the grid stays aligned with segments and junctions.
    let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
    for (const [s, e] of segments) {
      for (const p of [s, e]) {
        if (p[0] < bMinX) bMinX = p[0]; if (p[0] > bMaxX) bMaxX = p[0];
        if (p[1] < bMinY) bMinY = p[1]; if (p[1] > bMaxY) bMaxY = p[1];
      }
    }
    const cx = (bMinX + bMaxX) / 2, cy = (bMinY + bMaxY) / 2;
    const shift = ([x, y]) => [x - cx, y - cy];
    return {
      segments: segments.map(([s, e]) => [shift(s), shift(e)]),
      points:   junctions.map(shift),
      gridDots: gridDots.map(shift),
    };
  }

  const ALMOST_THRESHOLD = 0.85; // goal coverage ≥ this but not matched → show "almost" hint
  function updateAlmostHint() {
    const hint = document.getElementById('almost-hint');
    if (!hint) return;
    const s = lastProjectionStats;
    const close = s && !s.matched && s.goalCoverage >= ALMOST_THRESHOLD;
    hint.classList.toggle('visible', !!close);
  }
  function projectionGeometricMatches() {
    const rodShape = buildProjectedRodShape();
    lastProjectionStats = { ...measureGeometricMatch(rodShape, goalShape), rodShape };
    updateDebugPanel();
    updateAlmostHint();
    return lastProjectionStats.matched;
  }

  function checkVictory() {
    if (cleared || victoryImmune) return;
    if (projectionGeometricMatches()) { cleared = true; triggerClear(); }
  }

  function showOverlay(id) {
    document.getElementById(id).classList.add('visible');
    renderer.domElement.style.pointerEvents = 'none';
  }
  function overlayActive() {
    if (!document.body.classList.contains('mode-game')) return true;
    return document.querySelector('.overlay.visible') !== null;
  }
  function hideOverlay(id) {
    document.getElementById(id).classList.remove('visible');
    if (!overlayActive()) renderer.domElement.style.pointerEvents = 'auto';
  }

  function triggerClear() {
    completedLevels.add(currentLevel);
    saveProgress();
    rods.forEach(r => {
      r.allMeshes.forEach(m => {
        gsap.killTweensOf(m.material.color);
        gsap.killTweensOf(m.position);
        gsap.to(m.material.color, { r: COL_DRAG.r, g: COL_DRAG.g, b: COL_DRAG.b, duration: 0.25, yoyo: true, repeat: 3 });
        const currentY = m.position.y;
        gsap.to(m.position, { y: currentY + 0.38, duration: 0.28, yoyo: true, repeat: 1, ease: 'power2.out' });
      });
    });
    clearTimer = setTimeout(() => { clearTimer = null; showOverlay('clear-overlay'); }, 950);
  }

  const raycaster = new THREE.Raycaster();
  const ndcVec    = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const _tmpVec   = new THREE.Vector3();

  // The three principal drag planes; pick the one whose normal is most aligned with the view direction
  const PLANE_OPTS = [
    { normal: new THREE.Vector3(1, 0, 0), rx: 0,            ry: Math.PI / 2 }, // YZ plane
    { normal: new THREE.Vector3(0, 1, 0), rx: -Math.PI / 2, ry: 0 },           // XZ plane
    { normal: new THREE.Vector3(0, 0, 1), rx: 0,            ry: 0 },           // XY plane
  ];

  const dragIndicator = new THREE.Mesh(
    new THREE.PlaneGeometry(6 * CELL, 6 * CELL),
    new THREE.MeshBasicMaterial({
      color: 0x3399ff, transparent: true, opacity: 0.05,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  dragIndicator.visible = false;
  scene.add(dragIndicator);

  // Float grid dots shown on the active drag plane during a rod drag
  const _floatDotGeo = new THREE.SphereGeometry(0.015, 6, 6);
  const _floatDotMat = new THREE.MeshBasicMaterial({ color: 0x3399ff, transparent: true, opacity: 0.65 });
  const floatGrid    = new THREE.Group();
  dragIndicator.add(floatGrid);

  let dragMode     = null;
  let dragRod      = null;
  let dragPlaneIdx = -1;
  let pointerStart = null;
  let lastPointer  = null;
  let hasMoved     = false;
  let lastSnapKey  = null; // tracks current magnetised cell during a rod drag for haptic feedback

  function pulseSnap() {
    // Respect the user-facing toggle in settings (persisted via localStorage).
    if (typeof window !== 'undefined' &&
        typeof window.silhouetteHapticsEnabled === 'function' &&
        !window.silhouetteHapticsEnabled()) return;
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(SNAP_VIBRATE_MS); } catch {}
    }
  }
  const dragAnchor    = new THREE.Vector3(); // pointer's plane projection at drag start
  const dragRodAnchor = new THREE.Vector3(); // rod path[0] world position at drag start
  const dragOffset    = new THREE.Vector3(); // current world-space offset on the drag plane
  // Legal cell-space offset bounds for the active rod (x/z only; y is unconstrained).
  let dragMinDgx = 0, dragMaxDgx = 0, dragMinDgz = 0, dragMaxDgz = 0;

  function resetDragState() {
    dragMode     = null;
    dragRod      = null;
    dragPlaneIdx = -1;
    pointerStart = null;
    lastPointer  = null;
    hasMoved     = false;
    lastSnapKey  = null;
    dragOffset.set(0, 0, 0);
    dragIndicator.visible = false;
  }

  // Asymptotic rubber-band: as x grows, output approaches EDGE_OVERSHOOT_MAX with
  // diminishing returns. f(0) = 0 and f'(0) = 1 so it joins continuously with the
  // free-drag region inside the grid.
  function edgeRubberBand(x) {
    return EDGE_OVERSHOOT_MAX * (1 - Math.exp(-x / EDGE_OVERSHOOT_MAX));
  }

  // Apply edge resistance: inside [min, max] the value passes through; outside it
  // overshoots by a soft, asymptotically-bounded amount so the player sees the rod
  // tug against the wall instead of feeling stuck.
  function elasticClampCells(v, min, max) {
    if (v > max) return { value: max + edgeRubberBand(v - max), inside: false };
    if (v < min) return { value: min - edgeRubberBand(min - v), inside: false };
    return { value: v, inside: true };
  }

  // Magnetic-snap mapping for one axis: input v (raw cursor delta in cells), output
  // visual delta in cells. Within SNAP_BUFFER of an integer the value sticks exactly
  // (容錯緩衝); beyond that the rod accelerates away from the grid via smoothstep, so
  // the user feels rising resistance near the snap line (吸附阻力).
  function magnetize(v) {
    const n = Math.round(v);
    const d = v - n;
    const absD = Math.abs(d);
    if (absD <= SNAP_BUFFER) return n;
    const t = (absD - SNAP_BUFFER) / (SNAP_RANGE_END - SNAP_BUFFER); // 0→1 across resistance band
    const eased = t * t * (3 - 2 * t); // smoothstep
    return n + Math.sign(d) * SNAP_RANGE_END * eased;
  }

  // Visually offset the rod meshes by (ox, oy, oz) from their grid-anchored positions.
  // Used during drag to make the rod follow the pointer continuously, without changing rod.path.
  function setRodVisualOffset(rod, ox, oy, oz) {
    for (let i = 0; i < rod.path.length - 1; i++) {
      const p1 = nodeToWorld(rod.path[i]);
      const p2 = nodeToWorld(rod.path[i + 1]);
      const mx = (p1.x + p2.x) / 2 + ox;
      const my = (p1.y + p2.y) / 2 + oy;
      const mz = (p1.z + p2.z) / 2 + oz;
      rod.segMeshes[i].position.set(mx, my, mz);
      rod.hitMeshes[i].position.set(mx, my, mz);
    }
    for (let i = 0; i < rod.jointMeshes.length; i++) {
      const p = nodeToWorld(rod.path[i + 1]);
      rod.jointMeshes[i].position.set(p.x + ox, p.y + oy, p.z + oz);
    }
  }

  function updateActiveTile() {
    const grid = document.getElementById('level-grid');
    if (!grid) return;
    grid.querySelectorAll('.level-tile').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.level) === currentLevel);
    });
  }

  function setMode(mode) {
    const isHome   = mode === 'home';
    const isLevels = mode === 'levels';
    const isGame   = mode === 'game';
    const homeScreen    = document.getElementById('screen-home');
    const levelsScreen  = document.getElementById('screen-levels');
    const backGameBtn   = document.getElementById('back-game');
    const backLevelsBtn = document.getElementById('back-levels');

    document.body.classList.remove('mode-home', 'mode-levels', 'mode-game');
    document.body.classList.add('mode-' + mode);

    homeScreen.classList.toggle('visible', isHome);
    levelsScreen.classList.toggle('visible', isLevels);
    homeScreen.hidden    = !isHome;
    levelsScreen.hidden  = !isLevels;
    homeScreen.inert     = !isHome;
    levelsScreen.inert   = !isLevels;
    backGameBtn.hidden   = !isGame;
    backLevelsBtn.hidden = !isLevels;
    backGameBtn.inert    = !isGame;
    backLevelsBtn.inert  = !isLevels;

    resetDragState();
    hideOverlay('clear-overlay');
    hideOverlay('allclear-overlay');

    renderer.domElement.style.pointerEvents = isGame ? 'auto' : 'none';
    if (isLevels) {
      levelPage = Math.floor(currentLevel / 20);
      buildLevelTiles();
    }
  }

  function buildLevelTiles() {
    const grid = document.getElementById('level-grid');
    if (!grid) return;
    let hoverRod = grid.querySelector('#level-hover-rod');
    grid.innerHTML = '';
    if (!hoverRod) {
      hoverRod = document.createElement('div');
      hoverRod.id = 'level-hover-rod';
      hoverRod.setAttribute('aria-hidden', 'true');
    } else {
      hoverRod.classList.remove('visible');
      hoverRod.classList.remove('locked');
    }
    grid.appendChild(hoverRod);
    const moveHoverTo = (tile) => {
      if (hoverRod.classList.contains('locked')) return;
      const gridRect = grid.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      const bw = parseFloat(getComputedStyle(hoverRod).borderTopWidth) || 0;
      const half = bw / 2;
      const x = tileRect.left - gridRect.left - half;
      const y = tileRect.top  - gridRect.top  - half;
      hoverRod.style.transform = `translate(${x}px, ${y}px)`;
      hoverRod.style.width  = (tileRect.width  + bw) + 'px';
      hoverRod.style.height = (tileRect.height + bw) + 'px';
      hoverRod.classList.add('visible');
    };
    const start = levelPage * 20;
    const end   = Math.min(start + 20, LEVELS.length);
    for (let idx = start; idx < end; idx++) {
      const tile = document.createElement('button');
      tile.className     = 'level-tile' + (completedLevels.has(idx) ? ' completed' : '');
      tile.type          = 'button';
      tile.dataset.level = String(idx);
      tile.textContent   = String(idx + 1);
      tile.addEventListener('mouseenter', () => moveHoverTo(tile));
      tile.addEventListener('click', () => {
        grid.querySelectorAll('.level-tile.selected').forEach(t => t.classList.remove('selected'));
        tile.classList.add('selected');
        moveHoverTo(tile);
        hoverRod.classList.add('locked');
        document.body.classList.add('going-to-game');
        currentLevel = idx;
        loadLevel(idx);
        setTimeout(() => {
          document.body.classList.remove('going-to-game');
          hideOverlay('clear-overlay');
          hideOverlay('allclear-overlay');
          setMode('game');
        }, 1250);
      });
      grid.appendChild(tile);
    }
    if (!grid.dataset.hoverBound) {
      grid.addEventListener('mouseleave', () => {
        const r = grid.querySelector('#level-hover-rod');
        if (r && !r.classList.contains('locked')) r.classList.remove('visible');
      });
      grid.dataset.hoverBound = '1';
    }
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');
    if (prevBtn) prevBtn.disabled = levelPage === 0;
    if (nextBtn) nextBtn.disabled = end >= LEVELS.length;
    updateActiveTile();
  }

  function ndc(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndcVec.set(
       ((clientX - rect.left) / rect.width)  * 2 - 1,
      -((clientY - rect.top)  / rect.height) * 2 + 1
    );
    return ndcVec;
  }

  // Pick the rod whose projected polyline is closest to the cursor in screen space,
  // rather than the rod closest to the camera along the pick ray. This matches the
  // user's visual intent when rods overlap in depth or when the click lands just
  // off the (thin) rod geometry.
  const ROD_PICK_PIXELS = 40;
  function _distPointToSeg2D(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = x1 + t * dx, cy = y1 + t * dy;
    const ex = px - cx, ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function getRodAt(clientX, clientY) {
    if (!rods.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const halfW = rect.width  * 0.5;
    const halfH = rect.height * 0.5;

    let best = null, bestDist = Infinity;
    for (const rod of rods) {
      const pts = rod.path.map(node => {
        _tmpVec.copy(nodeToWorld(node)).project(camera);
        return { x: ( _tmpVec.x + 1) * halfW, y: (-_tmpVec.y + 1) * halfH };
      });
      let minD = Infinity;
      if (pts.length === 1) {
        const ex = pts[0].x - px, ey = pts[0].y - py;
        minD = Math.sqrt(ex * ex + ey * ey);
      } else {
        for (let i = 0; i < pts.length - 1; i++) {
          const d = _distPointToSeg2D(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
          if (d < minD) minD = d;
        }
      }
      if (minD < bestDist) { bestDist = minD; best = rod; }
    }
    return bestDist <= ROD_PICK_PIXELS ? best : null;
  }

  function highlightRod(rod, state) {
    // state: false/'idle' | 'hover' | true/'drag'
    let c;
    if (state === 'hover')                       c = COL_HOVER;
    else if (state === true || state === 'drag') c = COL_DRAG;
    else                                         c = COL_IDLE;
    for (const m of rod.allMeshes) {
      gsap.to(m.material.color, { r: c.r, g: c.g, b: c.b, duration: 0.14 });
    }
  }

  let hoverRod = null;
  function setHoverRod(rod) {
    if (hoverRod === rod) return;
    if (hoverRod && hoverRod !== dragRod) highlightRod(hoverRod, 'idle');
    hoverRod = rod;
    if (hoverRod && hoverRod !== dragRod)  highlightRod(hoverRod, 'hover');
    renderer.domElement.style.cursor = hoverRod ? 'grab' : '';
  }

  function snapToGrid(rod, worldPt, animate, duration) {
    const off = (gridSize - 1) / 2;

    // Path centroid in grid coordinates
    let cGx = 0, cGy = 0, cGz = 0;
    for (const [gx, gy, gz] of rod.path) { cGx += gx; cGy += gy; cGz += gz; }
    const n = rod.path.length;
    cGx /= n; cGy /= n; cGz /= n;

    // Convert worldPt to grid coordinates
    const tx = worldPt.x / CELL + off;
    const ty = worldPt.y / CELL;
    const tz = worldPt.z / CELL + off;

    let dgx = Math.round(tx - cGx);
    let dgy = Math.round(ty - cGy);
    let dgz = Math.round(tz - cGz);

    // Lock the axis perpendicular to the active drag plane so movement stays in-plane.
    // PLANE_OPTS index: 0 = YZ (lock x), 1 = XZ (lock y), 2 = XY (lock z).
    if      (dragPlaneIdx === 0) dgx = 0;
    else if (dragPlaneIdx === 1) dgy = 0;
    else if (dragPlaneIdx === 2) dgz = 0;

    // Clamp delta so no node leaves the grid (gx/gz within [0, gridSize-1], gy unconstrained)
    let minDgx = -Infinity, maxDgx = Infinity, minDgz = -Infinity, maxDgz = Infinity;
    for (const [gx, , gz] of rod.path) {
      minDgx = Math.max(minDgx, -gx);
      maxDgx = Math.min(maxDgx, gridSize - 1 - gx);
      minDgz = Math.max(minDgz, -gz);
      maxDgz = Math.min(maxDgz, gridSize - 1 - gz);
    }
    dgx = clamp(dgx, minDgx, maxDgx);
    dgz = clamp(dgz, minDgz, maxDgz);

    if (dgx === 0 && dgy === 0 && dgz === 0) return;

    rod.path = rod.path.map(([gx, gy, gz]) => [gx + dgx, gy + dgy, gz + dgz]);
    updateRodMeshPositions(rod, animate, duration);
  }

  let pendingPreDragSnap = null;
  function onDown(cx, cy) {
    pointerStart = { x: cx, y: cy };
    lastPointer  = { x: cx, y: cy };
    hasMoved     = false;
    dragMode     = null;
    dragRod      = getRodAt(cx, cy);
    // If a rod is grabbed, capture the pre-drag rod state. We only push it onto
    // the undo stack at onUp time if the drag actually moved a rod to a new cell.
    pendingPreDragSnap = dragRod ? snapshotRods() : null;
  }

  function onMove(cx, cy) {
    if (!pointerStart) return;
    const dx = cx - pointerStart.x, dy = cy - pointerStart.y;
    if (!hasMoved && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESH) {
      hasMoved = true;
      dragMode = dragRod ? 'rod' : 'cam';
      if (dragMode === 'rod') {
        highlightRod(dragRod, true);
        // Pick the principal plane whose normal is most aligned with the view direction
        const viewDir = new THREE.Vector3();
        camera.getWorldDirection(viewDir);
        let maxDot = -Infinity, bestIdx = 0;
        for (let i = 0; i < PLANE_OPTS.length; i++) {
          const dot = Math.abs(viewDir.dot(PLANE_OPTS[i].normal));
          if (dot > maxDot) { maxDot = dot; bestIdx = i; }
        }
        const bestOpt = PLANE_OPTS[bestIdx];
        dragPlaneIdx = bestIdx;
        const p0 = nodeToWorld(dragRod.path[0]);
        dragPlane.setFromNormalAndCoplanarPoint(bestOpt.normal, p0);
        dragRodAnchor.copy(p0);
        dragOffset.set(0, 0, 0);
        // Cache the legal cell-space offset range so no node leaves the x/z grid.
        dragMinDgx = -Infinity; dragMaxDgx = Infinity;
        dragMinDgz = -Infinity; dragMaxDgz = Infinity;
        for (const [gx, , gz] of dragRod.path) {
          dragMinDgx = Math.max(dragMinDgx, -gx);
          dragMaxDgx = Math.min(dragMaxDgx, gridSize - 1 - gx);
          dragMinDgz = Math.max(dragMinDgz, -gz);
          dragMaxDgz = Math.min(dragMaxDgz, gridSize - 1 - gz);
        }
        // Anchor the pointer to its plane projection at drag start, so subsequent
        // moves yield a delta that we can apply directly to the rod.
        raycaster.setFromCamera(ndc(cx, cy), camera);
        if (raycaster.ray.intersectPlane(dragPlane, _tmpVec)) {
          dragAnchor.copy(_tmpVec);
        } else {
          dragAnchor.copy(p0);
        }
        dragIndicator.rotation.set(bestOpt.rx, bestOpt.ry, 0);
        dragIndicator.position.copy(p0);
        dragIndicator.visible = true;

        floatGrid.clear();
        for (let i = 0; i < 5; i++) {
          for (let j = 0; j < 5; j++) {
            const dot = new THREE.Mesh(_floatDotGeo, _floatDotMat.clone());
            if      (bestIdx === 1) dot.position.set( (i - 2) * CELL, -(j - 2) * CELL, 0); // XZ horizontal
            else if (bestIdx === 2) dot.position.set( (i - 2) * CELL,  (j - 2) * CELL, 0); // XY vertical
            else                   dot.position.set(-(j - 2) * CELL,  (i - 2) * CELL, 0); // YZ vertical
            floatGrid.add(dot);
          }
        }
      }
    }
    if (!hasMoved) return;

    if (dragMode === 'rod' && dragRod) {
      raycaster.setFromCamera(ndc(cx, cy), camera);
      if (raycaster.ray.intersectPlane(dragPlane, _tmpVec)) {
        dragOffset.copy(_tmpVec).sub(dragAnchor);
        // Lock the axis perpendicular to the drag plane.
        if      (dragPlaneIdx === 0) dragOffset.x = 0;
        else if (dragPlaneIdx === 1) dragOffset.y = 0;
        else if (dragPlaneIdx === 2) dragOffset.z = 0;
        // x/z get an elastic clamp so the rod rubber-bands a little past the grid
        // edge (signals "you've hit the wall" without feeling stuck); y is free.
        const ex = elasticClampCells(dragOffset.x / CELL, dragMinDgx, dragMaxDgx);
        const ez = elasticClampCells(dragOffset.z / CELL, dragMinDgz, dragMaxDgz);
        const rawDy = dragOffset.y / CELL;
        // Inside the grid the magnetic snap takes over; outside, skip magnetise so
        // the visual position keeps following the elastic curve smoothly.
        const visX = (dragPlaneIdx === 0) ? 0 : (ex.inside ? magnetize(ex.value) : ex.value) * CELL;
        const visY = (dragPlaneIdx === 1) ? 0 : magnetize(rawDy) * CELL;
        const visZ = (dragPlaneIdx === 2) ? 0 : (ez.inside ? magnetize(ez.value) : ez.value) * CELL;
        setRodVisualOffset(dragRod, visX, visY, visZ);

        // Haptic pulse when the rod magnetises onto a new integer cell.
        const sx = Math.round(ex.value), sy = Math.round(rawDy), sz = Math.round(ez.value);
        const inSnapX = (dragPlaneIdx === 0) || Math.abs(ex.value - sx) <= SNAP_BUFFER;
        const inSnapY = (dragPlaneIdx === 1) || Math.abs(rawDy   - sy) <= SNAP_BUFFER;
        const inSnapZ = (dragPlaneIdx === 2) || Math.abs(ez.value - sz) <= SNAP_BUFFER;
        if (inSnapX && inSnapY && inSnapZ) {
          const key = `${sx},${sy},${sz}`;
          if (key !== lastSnapKey) {
            if (lastSnapKey !== null) pulseSnap();
            lastSnapKey = key;
          }
        } else {
          lastSnapKey = null;
        }
      }
    } else if (dragMode === 'cam') {
      const ddx = cx - lastPointer.x, ddy = cy - lastPointer.y;
      camTheta -= ddx * 0.009;
      camPhi    = Math.max(CAM_PHI_MIN, Math.min(CAM_PHI_MAX, camPhi + ddy * 0.007));
      setCameraOrbit(camTheta, camPhi);
      updateCamera();
    }
    lastPointer = { x: cx, y: cy };
  }

  function onUp(cx, cy) {
    if (dragMode === 'rod' && dragRod) {
      // Snap the accumulated drag offset to the nearest grid step and tween there.
      let dgx = Math.round(dragOffset.x / CELL);
      let dgy = Math.round(dragOffset.y / CELL);
      let dgz = Math.round(dragOffset.z / CELL);
      if      (dragPlaneIdx === 0) dgx = 0;
      else if (dragPlaneIdx === 1) dgy = 0;
      else if (dragPlaneIdx === 2) dgz = 0;
      // Clamp delta so no node leaves the x/z grid bounds (gy unconstrained).
      let minDgx = -Infinity, maxDgx = Infinity, minDgz = -Infinity, maxDgz = Infinity;
      for (const [gx, , gz] of dragRod.path) {
        minDgx = Math.max(minDgx, -gx);
        maxDgx = Math.min(maxDgx, gridSize - 1 - gx);
        minDgz = Math.max(minDgz, -gz);
        maxDgz = Math.min(maxDgz, gridSize - 1 - gz);
      }
      dgx = clamp(dgx, minDgx, maxDgx);
      dgz = clamp(dgz, minDgz, maxDgz);
      if (dgx !== 0 || dgy !== 0 || dgz !== 0) {
        if (pendingPreDragSnap) pushUndoSnapshot(pendingPreDragSnap);
        dragRod.path = dragRod.path.map(([gx, gy, gz]) => [gx + dgx, gy + dgy, gz + dgz]);
      }
      pendingPreDragSnap = null;
      // gsap reads the meshes' current (offset) positions as the tween's "from",
      // so this animates the rubber-band back to the snapped grid point.
      updateRodMeshPositions(dragRod, true, 0.20);
      const rod = dragRod;
      setTimeout(() => { highlightRod(rod, false); checkVictory(); }, 220);
    } else if (dragMode === 'cam') {
      // Defer victory check to avoid false triggers from the pointer-up event itself
      checkVictory();
    }
    resetDragState();
  }

  document.getElementById('next-btn').addEventListener('click', e => {
    e.stopPropagation();
    resetDragState();
    hideOverlay('clear-overlay');
    currentLevel++;
    if (currentLevel >= LEVELS.length) {
      showOverlay('allclear-overlay');
    } else {
      loadLevel(currentLevel);
    }
  });

  document.getElementById('restart-btn').addEventListener('click', e => {
    e.stopPropagation();
    resetDragState();
    hideOverlay('allclear-overlay');
    currentLevel = 0;
    loadLevel(0);
  });

  document.getElementById('start-btn').addEventListener('click',   () => setMode('levels'));
  document.getElementById('back-game').addEventListener('click',   () => setMode('levels'));
  document.getElementById('back-levels').addEventListener('click', () => setMode('home'));

  let pageSwapAnimating = false;
  function animatePageSwap(newPage, dir) {
    if (pageSwapAnimating) return;
    const grid = document.getElementById('level-grid');
    if (!grid) { levelPage = newPage; buildLevelTiles(); return; }
    pageSwapAnimating = true;
    document.body.classList.add('page-swapping');
    const leaveCls = dir === 'right' ? 'leaving-right' : 'leaving-left';
    const enterCls = dir === 'right' ? 'entering-right' : 'entering-left';
    const oldTiles = Array.from(grid.children);
    oldTiles.forEach(t => t.classList.add(leaveCls));
    setTimeout(() => {
      levelPage = newPage;
      buildLevelTiles();
      const newTiles = Array.from(grid.children);
      // CSS keyframe animation runs deterministically once the class is added.
      // Remove the class after the 0.55s animation finishes so subsequent
      // renders aren't stuck in the keyframe's final-frame fill.
      newTiles.forEach(t => t.classList.add(enterCls));
      setTimeout(() => {
        newTiles.forEach(t => t.classList.remove(enterCls));
      }, 580);
      setTimeout(() => {
        pageSwapAnimating = false;
        document.body.classList.remove('page-swapping');
        document.body.classList.add('page-swap-cooldown');
        const clearCooldown = () => {
          document.body.classList.remove('page-swap-cooldown');
          window.removeEventListener('mousemove', clearCooldown);
          window.removeEventListener('pointermove', clearCooldown);
        };
        window.addEventListener('mousemove', clearCooldown);
        window.addEventListener('pointermove', clearCooldown);
      }, 550);
    }, 550);
  }

  document.getElementById('prev-page').addEventListener('click', () => {
    if (pageSwapAnimating) return;
    if (levelPage > 0) animatePageSwap(levelPage - 1, 'left');
  });
  document.getElementById('next-page').addEventListener('click', () => {
    if (pageSwapAnimating) return;
    if ((levelPage + 1) * 20 < LEVELS.length) animatePageSwap(levelPage + 1, 'right');
  });

  // Soft reset: keep meshes, animate rod paths back to their level-start state and
  // glide the camera back to its default orientation/zoom over 0.5s. Falls back to
  // a hard load if rod topology no longer matches the level (shouldn't happen, but
  // keeps the button safe if level data is reloaded).
  function softResetLevel() {
    const RESET_DURATION_S = 0.5;
    if (!activeScramble || activeScramble.idx !== currentLevel || !rods.length) {
      loadLevel(currentLevel, { preserveSeed: true });
      return;
    }
    const lvl = scrambleLevel(LEVELS[currentLevel], activeScramble.seed);
    const initRods = lvl.rods;
    // Topology check: same rod count and same node count per rod.
    if (initRods.length !== rods.length) {
      loadLevel(currentLevel, { preserveSeed: true });
      return;
    }
    for (let i = 0; i < rods.length; i++) {
      const initPath = (initRods[i].path || [])
        .map(n => (n.length === 3 ? [...n] : [n[0], 0, n[1]]));
      if (initPath.length !== rods[i].path.length) {
        loadLevel(currentLevel, { preserveSeed: true });
        return;
      }
    }

    resetDragState();
    hideOverlay('clear-overlay');
    cleared = false;
    undoStack = [];
    updateUndoBtn();
    const _almost = document.getElementById('almost-hint');
    if (_almost) _almost.classList.remove('visible');
    // Reuse the immunity window so the easing-back can't accidentally trigger victory.
    victoryImmune = true;
    setTimeout(() => { victoryImmune = false; }, RESET_DURATION_S * 1000 + 200);

    // Animate rods to initial paths.
    for (let i = 0; i < rods.length; i++) {
      const initPath = (initRods[i].path || [])
        .map(n => (n.length === 3 ? [...n] : [n[0], 0, n[1]]));
      rods[i].path = initPath;
      updateRodMeshPositions(rods[i], true, RESET_DURATION_S);
    }

    // Animate camera back to defaults (same easing curve as reset-view).
    const fromTheta = camTheta, fromPhi = camPhi, fromZoom = camZoomFactor;
    const targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, CAM_ZOOM_LOAD * (5 / Math.max(gridSize, 1))));
    const obj = { t: 0 };
    gsap.to(obj, {
      t: 1, duration: RESET_DURATION_S, ease: 'power2.inOut',
      onUpdate: () => {
        camTheta = fromTheta + (CAM_THETA_DEFAULT - fromTheta) * obj.t;
        camPhi   = fromPhi   + (CAM_PHI_DEFAULT   - fromPhi)   * obj.t;
        camZoomFactor = fromZoom + (targetZoom - fromZoom) * obj.t;
        setCameraOrbit(camTheta, camPhi);
        applyZoom();
        updateCamera();
      },
      onComplete: () => checkVictory(),
    });
  }

  document.getElementById('reset-btn').addEventListener('click', softResetLevel);

  document.getElementById('undo-btn').addEventListener('click', () => {
    if (!undoStack.length) return;
    const snap = undoStack.pop();
    updateUndoBtn();
    resetDragState();
    applySnapshot(snap, true);
    setTimeout(() => checkVictory(), 250);
  });

  document.getElementById('reset-view-btn').addEventListener('click', () => {
    resetDragState();
    const fromTheta = camTheta, fromPhi = camPhi, fromZoom = camZoomFactor;
    const targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, CAM_ZOOM_LOAD * (5 / Math.max(gridSize, 1))));
    const obj = { t: 0 };
    gsap.to(obj, {
      t: 1, duration: 0.5, ease: 'power2.inOut',
      onUpdate: () => {
        camTheta = fromTheta + (CAM_THETA_DEFAULT - fromTheta) * obj.t;
        camPhi   = fromPhi   + (CAM_PHI_DEFAULT   - fromPhi)   * obj.t;
        camZoomFactor = fromZoom + (targetZoom - fromZoom) * obj.t;
        setCameraOrbit(camTheta, camPhi);
        applyZoom();
        updateCamera();
      },
      onComplete: () => checkVictory(),
    });
  });

  document.addEventListener('silhouette:resetprogress', () => {
    completedLevels.clear();
    currentLevel = 0;
    saveProgress();
    buildLevelTiles();
  });

  renderer.domElement.addEventListener('mousedown', e => {
    if (e.button === 0 && !overlayActive()) onDown(e.clientX, e.clientY);
  });
  renderer.domElement.addEventListener('mouseleave', () => setHoverRod(null));
  window.addEventListener('mousemove', e => {
    if (overlayActive()) return;
    onMove(e.clientX, e.clientY);
    // Hover affordance: only when no drag is in progress and pointer is fine (mouse, not touch).
    if (!_coarsePointer && !pointerStart && document.body.classList.contains('mode-game')) {
      setHoverRod(getRodAt(e.clientX, e.clientY));
    }
  });
  window.addEventListener('mouseup', e => {
    if (e.button === 0) {
      if (!overlayActive()) onUp(e.clientX, e.clientY);
      else resetDragState();
    }
  });

  let pinchMode      = false;
  let pinchStartDist = 0;
  let pinchStartZoom = 1;

  function getPinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  renderer.domElement.addEventListener('touchstart', e => {
    if (overlayActive()) return;
    e.preventDefault();
    if (e.touches.length === 2) {
      pinchMode      = true;
      pinchStartDist = getPinchDist(e.touches);
      pinchStartZoom = camZoomFactor;
      resetDragState();
    } else if (e.touches.length === 1 && !pinchMode) {
      const t = e.touches[0];
      onDown(t.clientX, t.clientY);
    }
  }, { passive: false });

  renderer.domElement.addEventListener('touchmove', e => {
    if (overlayActive()) return;
    e.preventDefault();
    if (pinchMode && e.touches.length === 2) {
      const dist = getPinchDist(e.touches);
      camZoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStartZoom * (dist / pinchStartDist)));
      applyZoom();
    } else if (!pinchMode && e.touches.length === 1) {
      const t = e.touches[0];
      onMove(t.clientX, t.clientY);
    }
  }, { passive: false });

  renderer.domElement.addEventListener('touchend', e => {
    if (overlayActive()) return;
    if (pinchMode) {
      if (e.touches.length < 2) {
        pinchMode = false;
        resetDragState();
      }
      return;
    }
    if (e.touches.length === 0) {
      const t = e.changedTouches[0];
      onUp(t.clientX, t.clientY);
    }
  });

  renderer.domElement.addEventListener('touchcancel', () => {
    pinchMode = false;
    resetDragState();
  });

  // Intercept browser-level zoom so the HTML UI doesn't scale
  window.addEventListener('wheel', e => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
      e.preventDefault();
    }
    if (e.key === '`' && document.body.classList.contains('mode-game')) {
      document.getElementById('debug-wrap').classList.toggle('visible');
    }
  });

  // Scroll wheel on the canvas zooms the Three.js camera only, not the HTML UI
  renderer.domElement.addEventListener('wheel', e => {
    e.preventDefault();
    if (overlayActive()) return;
    const factor = e.deltaY > 0 ? 0.99 : 1.01;
    camZoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camZoomFactor * factor));
    applyZoom();
  }, { passive: false });

  window.addEventListener('resize', () => {
    resizeCanvasWrap();
    camAspect = window.innerWidth / window.innerHeight;
    applyZoom();
  });

  buildLevelTiles();
  if (_editorTestMode) {
    currentLevel = 0;
    setMode('game');
  } else {
    setMode('home');
  }
  loadLevel(currentLevel);

  (function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  })();
}
