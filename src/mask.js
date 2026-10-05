// Monster mask rendered as a deformable mesh.
//
// The PNG is split into a grid of textured triangles. Each grid vertex has:
//   - a rest position in image pixels (u, v)
//   - an "anchor": where that vertex sits when the mask is on the face
//   - a simulated screen position (Verlet: pos + prev)
//
// States:
//   onFace    vertices = anchors (rigidly tracks the face)
//   peeling   grabbed; vertices stretch toward the hand with distance falloff
//   returning released early; vertices spring back onto the anchors
//   held      torn off; soft-body hangs from the pinch point
//   falling   released after removal; gravity until off-screen
//   gone      waiting to respawn on the face

export const MASK_SRC = `${import.meta.env.BASE_URL}monster-mask.png`;

// Where the face sits inside a mask PNG (image pixels). Each monster has its
// own; this one was measured from monster-mask.png (the default green monster).
export const DEFAULT_ART = {
  anchorX: 663, // horizontal face center
  anchorY: 725, // midpoint between forehead line and chin
  faceTop: 300, // where real forehead (landmark 10) should land
  faceBottom: 1150, // where real chin (landmark 152) should land
  faceWidth: 586, // cheek-to-cheek width of the green face
};

/**
 * Fallback fit for a PNG with no measured values: derived from the bounding
 * box of its visible pixels (face ≈ central part of the artwork).
 */
export function artFromAlpha(image) {
  const { w, h, alpha } = buildAlphaMap(image);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 64) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return DEFAULT_ART;
  const left = x0 * ALPHA_CELL;
  const top = y0 * ALPHA_CELL;
  const bw = (x1 - x0 + 1) * ALPHA_CELL;
  const bh = (y1 - y0 + 1) * ALPHA_CELL;
  const faceTop = top + bh * 0.22;
  const faceBottom = top + bh * 0.88;
  return {
    anchorX: left + bw / 2,
    anchorY: (faceTop + faceBottom) / 2,
    faceTop,
    faceBottom,
    faceWidth: bw * 0.62,
  };
}

// How much bigger than the real face the art should be (>1 = more coverage).
const FIT = {
  coverX: 1.15,
  coverY: 1.12,
  offsetY: -0.04, // shift along head's up axis, as a fraction of face height
};

const SMOOTHING = 22; // face-follow smoothing; higher = snappier
const LOST_FADE_MS = 1200; // fade out after the face disappears (only when on face). Long, because a hand near the face often hides it briefly.

// Mesh
const GRID_X = 14;
const GRID_Y = 14;

// Interaction tuning
// STEP 1: simple grab + local mesh stretch only. The full peel / tear-off /
// gravity code further below is kept but bypassed while this is true.
export const SIMPLE_GRAB = true;

// Local stretch around the grabbed point (STEP 1).
export const STRETCH = {
  radius: 260, // image px: how far around the grab point the mesh follows the hand
  followNear: 60, // follow speed (1/s) at the grab point — basically instant
  followFar: 10, // follow speed at the edge of the stretch area — rubbery lag
  releaseRate: 12, // how fast the stretch relaxes back onto the face after release
  // STEP 2: the mask pops off once the grabbed mesh point is this far from its
  // original spot on the face (× mask face height ≈ 1.12 × real face height).
  removePull: 0.8,
};

export const PEEL = {
  grabMarginPx: 40, // how close (screen px, CSS) a pinch must be to the visible mask
  removePull: 0.7, // pull distance (× mask face height) that tears the mask off
  falloffMin: 220, // stretch radius around grab point at the start (image px)
  falloffMax: 1100, // stretch radius right before removal (image px)
  globalDetach: 0.55, // how much the whole mask drifts toward the hand near removal
};

const PHYS = {
  step: 1 / 60,
  iterations: 6,
  damping: 0.975,
  gravity: 2.2, // × view height per s²
  stretchMax: 1.18, // rubber: links may stretch this much before resisting
  compressMin: 0.75,
  bendCompressMin: 0.35, // 2-apart links may fold much more → mask bends/sags
  shapeStiffness: 0.03, // 0..1 per step: pull toward the original mask shape (rotated). Lower = floppier
  returnSpring: 0.16,
  returnDamping: 0.8,
  respawnMs: 1200,
};

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

const lerp = (a, b, t) => a + (b - a) * t;

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Low-res alpha map of the image, for hit-testing and skipping empty cells.
const ALPHA_CELL = 8;
function buildAlphaMap(img) {
  const w = Math.ceil(img.width / ALPHA_CELL);
  const h = Math.ceil(img.height / ALPHA_CELL);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];
  return { w, h, alpha };
}

export class Mask {
  constructor(image, art = DEFAULT_ART) {
    this.image = image;
    this.art = art; // where the face sits inside this PNG
    this.artFaceH = art.faceBottom - art.faceTop;
    this.alphaMap = buildAlphaMap(image);

    // Smoothed face pose. (x, y) = where the art's anchor point is drawn.
    this.pose = { x: 0, y: 0, sx: 1, sy: 1, rotation: 0, squashX: 1, shiftX: 0 };
    this.target = null;
    this.hasPose = false;
    this.alpha = 0;
    this.lostMs = Infinity;

    this.state = 'onFace';
    this.stateMs = 0;
    this.grab = null; // { u, v, cell, weights }
    this.pull = 0; // pull distance / mask face height
    this.pinch = null; // current pinch point being followed
    this.accum = 0;

    this.buildMesh();
  }

  get grabbed() {
    return this.state === 'peeling' || this.state === 'held' || this.state === 'rigidGrab';
  }

  get removed() {
    return this.state === 'held' || this.state === 'falling' || this.state === 'gone';
  }

  // ---------- Mesh setup ----------

  buildMesh() {
    const W = this.image.width;
    const H = this.image.height;
    const nx = GRID_X + 1;
    const ny = GRID_Y + 1;
    this.cellW = W / GRID_X;
    this.cellH = H / GRID_Y;
    this.nx = nx;
    this.ny = ny;

    const n = nx * ny;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.ax = new Float32Array(n); // anchors (screen)
    this.ay = new Float32Array(n);
    this.px = new Float32Array(n); // positions
    this.py = new Float32Array(n);
    this.ox = new Float32Array(n); // previous positions
    this.oy = new Float32Array(n);
    this.w = new Float32Array(n); // current peel weight (for debug)
    this.offX = new Float32Array(n); // deformation offset from the anchor (STEP 1)
    this.offY = new Float32Array(n);

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        this.u[k] = i * this.cellW;
        this.v[k] = j * this.cellH;
      }
    }

    // Visible cells (skip fully transparent ones when drawing)
    this.cells = [];
    for (let j = 0; j < GRID_Y; j++) {
      for (let i = 0; i < GRID_X; i++) {
        if (this.cellHasAlpha(i, j)) this.cells.push([i, j]);
      }
    }

    // Links: structural, shear and bend (2 apart) — keeps the sheet from crumpling.
    const links = [];
    const kinds = []; // 0 = structural/shear, 1 = bend
    const add = (i0, j0, i1, j1, kind = 0) => {
      if (i1 < 0 || j1 < 0 || i1 >= nx || j1 >= ny) return;
      links.push(j0 * nx + i0, j1 * nx + i1);
      kinds.push(kind);
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        add(i, j, i + 1, j);
        add(i, j, i, j + 1);
        add(i, j, i + 1, j + 1);
        add(i, j, i - 1, j + 1);
        add(i, j, i + 2, j, 1);
        add(i, j, i, j + 2, 1);
      }
    }
    this.links = new Uint16Array(links);
    this.linkKind = new Uint8Array(kinds);
    this.rest = new Float32Array(links.length / 2);
  }

  cellHasAlpha(ci, cj) {
    const { w, h, alpha } = this.alphaMap;
    const x0 = Math.floor((ci * this.cellW) / ALPHA_CELL);
    const x1 = Math.min(w - 1, Math.ceil(((ci + 1) * this.cellW) / ALPHA_CELL));
    const y0 = Math.floor((cj * this.cellH) / ALPHA_CELL);
    const y1 = Math.min(h - 1, Math.ceil(((cj + 1) * this.cellH) / ALPHA_CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (alpha[y * w + x] > 8) return true;
    return false;
  }

  // ---------- Face pose ----------

  static poseFromFace(face, art) {
    // When the head turns, cheek-to-cheek width shrinks; height is more stable,
    // so don't let the mask get narrower than the face is tall.
    const faceW = Math.max(face.width, face.height * 0.85);
    const sx = (faceW * FIT.coverX) / art.faceWidth;
    const sy = (face.height * FIT.coverY) / (art.faceBottom - art.faceTop);

    const up = { x: Math.sin(face.roll), y: -Math.cos(face.roll) };
    const lift = -FIT.offsetY * face.height + face.pitch * face.height * 0.05;
    const yaw = Math.max(-1, Math.min(1, face.yaw));

    return {
      x: face.center.x + up.x * lift,
      y: face.center.y + up.y * lift,
      sx,
      sy,
      rotation: face.roll,
      squashX: 1 - Math.abs(yaw) * 0.18,
      shiftX: yaw * faceW * 0.1,
    };
  }

  updatePose(face, dtMs) {
    if (face) {
      this.target = Mask.poseFromFace(face, this.art);
      this.lostMs = 0;
    } else {
      this.lostMs += dtMs;
    }
    if (!this.target) return;

    if (!this.hasPose) {
      Object.assign(this.pose, this.target);
      this.hasPose = true;
      this.computeAnchors();
      this.snapToAnchors();
      return;
    }
    const t = 1 - Math.exp((-SMOOTHING * dtMs) / 1000);
    const p = this.pose;
    const q = this.target;
    p.x = lerp(p.x, q.x, t);
    p.y = lerp(p.y, q.y, t);
    p.sx = lerp(p.sx, q.sx, t);
    p.sy = lerp(p.sy, q.sy, t);
    p.rotation = lerpAngle(p.rotation, q.rotation, t);
    p.squashX = lerp(p.squashX, q.squashX, t);
    p.shiftX = lerp(p.shiftX, q.shiftX, t);
  }

  /** Image px (u, v) → screen px, for the mask sitting on the face. */
  imageToScreen(u, v, out) {
    const p = this.pose;
    const lx = (u - this.art.anchorX) * p.sx * p.squashX + p.shiftX;
    const ly = (v - this.art.anchorY) * p.sy;
    const c = Math.cos(p.rotation);
    const s = Math.sin(p.rotation);
    out.x = p.x + lx * c - ly * s;
    out.y = p.y + lx * s + ly * c;
    return out;
  }

  /** Screen px → image px, for the mask sitting on the face. */
  toImageSpace(pt) {
    const p = this.pose;
    const dx = pt.x - p.x;
    const dy = pt.y - p.y;
    const c = Math.cos(-p.rotation);
    const s = Math.sin(-p.rotation);
    const rx = dx * c - dy * s - p.shiftX;
    const ry = dx * s + dy * c;
    return { x: rx / (p.sx * p.squashX) + this.art.anchorX, y: ry / p.sy + this.art.anchorY };
  }

  computeAnchors() {
    const tmp = { x: 0, y: 0 };
    for (let k = 0; k < this.u.length; k++) {
      this.imageToScreen(this.u[k], this.v[k], tmp);
      this.ax[k] = tmp.x;
      this.ay[k] = tmp.y;
    }
  }

  snapToAnchors() {
    this.px.set(this.ax);
    this.py.set(this.ay);
    this.ox.set(this.ax);
    this.oy.set(this.ay);
    this.w.fill(0);
  }

  maskFaceHeight() {
    return this.artFaceH * this.pose.sy;
  }

  // ---------- Hit test ----------

  /** Returns image coords {x, y} if pt is on / near visible mask pixels, else null. */
  hitTest(pt, marginPx) {
    if (!this.hasPose || this.alpha < 0.5) return null;
    const q = this.toImageSpace(pt);
    const { w, h, alpha } = this.alphaMap;
    const rCells = Math.ceil(marginPx / this.pose.sy / ALPHA_CELL);
    const cx = Math.floor(q.x / ALPHA_CELL);
    const cy = Math.floor(q.y / ALPHA_CELL);
    for (let y = cy - rCells; y <= cy + rCells; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = cx - rCells; x <= cx + rCells; x++) {
        if (x < 0 || x >= w) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > rCells * rCells) continue;
        if (alpha[y * w + x] > 128) {
          // Clamp to the image so the grab point is on the mesh.
          return {
            x: Math.min(Math.max(q.x, 0), this.image.width - 0.01),
            y: Math.min(Math.max(q.y, 0), this.image.height - 0.01),
          };
        }
      }
    }
    return null;
  }

  // ---------- Interaction ----------

  /** Grab info for image point uv: the mesh cell it's in + bilinear weights. */
  makeGrab(uv) {
    const u = Math.min(Math.max(uv.x, 0), this.image.width - 0.01);
    const v = Math.min(Math.max(uv.y, 0), this.image.height - 0.01);
    const ci = Math.min(GRID_X - 1, Math.floor(u / this.cellW));
    const cj = Math.min(GRID_Y - 1, Math.floor(v / this.cellH));
    const fx = u / this.cellW - ci;
    const fy = v / this.cellH - cj;
    const k00 = cj * this.nx + ci;
    return {
      u,
      v,
      corners: [k00, k00 + 1, k00 + this.nx, k00 + this.nx + 1],
      weights: [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy],
    };
  }

  startGrab(uv, pinch) {
    this.grab = this.makeGrab(uv);
    this.pinch = { ...pinch };
    this.setState('peeling');
  }

  /** Back to the initial state: a fresh, undeformed mask on the tracked face. */
  reset() {
    this.grab = null;
    this.pinch = null;
    this.pull = 0;
    this.accum = 0;
    this.restX = null;
    this.restY = null;
    this.offX.fill(0);
    this.offY.fill(0);
    this.alpha = 0; // fades back in on the face
    this.setState('onFace');
    if (this.hasPose) {
      this.computeAnchors();
      this.snapToAnchors();
    }
  }

  setState(s) {
    this.state = s;
    this.stateMs = 0;
  }

  /** Moves the grab-cell corners so the exact grabbed point lands on the pinch. */
  pinGrabPoint() {
    const { corners, weights } = this.grab;
    let gx = 0;
    let gy = 0;
    for (let i = 0; i < 4; i++) {
      gx += this.px[corners[i]] * weights[i];
      gy += this.py[corners[i]] * weights[i];
    }
    const ex = this.pinch.x - gx;
    const ey = this.pinch.y - gy;
    for (let i = 0; i < 4; i++) {
      this.px[corners[i]] += ex;
      this.py[corners[i]] += ey;
    }
  }

  freezeRestLengths() {
    // Rest lengths = link lengths on the face at the moment of removal.
    const L = this.links;
    for (let i = 0; i < this.rest.length; i++) {
      const a = L[i * 2];
      const b = L[i * 2 + 1];
      this.rest[i] = Math.hypot(this.ax[a] - this.ax[b], this.ay[a] - this.ay[b]);
    }
  }

  /**
   * Soft shape matching: find the rotation that best fits the rest shape onto
   * the current vertices, then nudge every vertex toward that fitted shape.
   * Keeps the hanging mask recognisable while still letting it bend and sag.
   */
  matchShape(stiffness) {
    if (!this.restX) return;
    const n = this.u.length;
    const { px, py, restX, restY } = this;
    let cx = 0, cy = 0, rx = 0, ry = 0;
    for (let k = 0; k < n; k++) {
      cx += px[k];
      cy += py[k];
      rx += restX[k];
      ry += restY[k];
    }
    cx /= n;
    cy /= n;
    rx /= n;
    ry /= n;
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) {
      const ax = restX[k] - rx;
      const ay = restY[k] - ry;
      const bx = px[k] - cx;
      const by = py[k] - cy;
      num += ax * by - ay * bx;
      den += ax * bx + ay * by;
    }
    const ang = Math.atan2(num, den);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (let k = 0; k < n; k++) {
      const ax = restX[k] - rx;
      const ay = restY[k] - ry;
      const tx = cx + ax * c - ay * s;
      const ty = cy + ax * s + ay * c;
      px[k] += (tx - px[k]) * stiffness;
      py[k] += (ty - py[k]) * stiffness;
    }
  }

  solveLinks() {
    const L = this.links;
    const px = this.px;
    const py = this.py;
    for (let i = 0; i < this.rest.length; i++) {
      const a = L[i * 2];
      const b = L[i * 2 + 1];
      const dx = px[b] - px[a];
      const dy = py[b] - py[a];
      const d = Math.hypot(dx, dy) || 1e-6;
      const r = this.rest[i];
      let targetLen;
      if (d > r * PHYS.stretchMax) targetLen = r * PHYS.stretchMax;
      else if (d < r * (this.linkKind[i] ? PHYS.bendCompressMin : PHYS.compressMin))
        targetLen = r * (this.linkKind[i] ? PHYS.bendCompressMin : PHYS.compressMin);
      else continue;
      const diff = ((d - targetLen) / d) * 0.5;
      px[a] += dx * diff;
      py[a] += dy * diff;
      px[b] -= dx * diff;
      py[b] -= dy * diff;
    }
  }

  /**
   * Main per-frame update.
   * input = { pinching, pinchStarted, pinchPoint }, viewH = canvas height.
   */
  update(face, dtMs, input, viewH) {
    this.updatePose(face, dtMs);
    if (!this.hasPose) return;
    if (SIMPLE_GRAB) {
      this.stateMs += dtMs;
      this.computeAnchors();
      this.simpleUpdate(input, dtMs);
      if (this.state === 'onFace' || this.state === 'rigidGrab') {
        this.stretchStep(dtMs);
        if (this.state === 'rigidGrab' && this.pull >= STRETCH.removePull) this.popOff();
      } else {
        // Removed: soft-body simulation (held / falling / gone).
        this.accum = Math.min(this.accum + dtMs / 1000, PHYS.step * 4);
        while (this.accum >= PHYS.step) {
          this.step(PHYS.step, viewH);
          this.accum -= PHYS.step;
        }
      }
      return;
    }
    this.stateMs += dtMs;

    // Anchors follow the face (frozen while the face is lost).
    if (face || this.state === 'onFace') this.computeAnchors();

    // Grab only on the frame the pinch starts, and only on the visible mask.
    if (input.pinchStarted && input.pinchPoint && (this.state === 'onFace' || this.state === 'returning')) {
      const uv = this.hitTest(input.pinchPoint, PEEL.grabMarginPx * (window.devicePixelRatio || 1));
      if (uv) this.startGrab(uv, input.pinchPoint);
    }

    if (input.pinchPoint && this.grabbed) this.pinch = { ...input.pinchPoint };

    // Release
    if (!input.pinching) {
      if (this.state === 'peeling') this.setState('returning');
      else if (this.state === 'held') this.setState('falling');
    }

    // Fixed-step simulation
    this.accum = Math.min(this.accum + dtMs / 1000, PHYS.step * 4);
    while (this.accum >= PHYS.step) {
      this.step(PHYS.step, viewH);
      this.accum -= PHYS.step;
    }

    // Visibility
    const ta = 1 - Math.exp((-12 * dtMs) / 1000);
    if (this.state === 'onFace') {
      this.alpha = lerp(this.alpha, this.lostMs < LOST_FADE_MS ? 1 : 0, ta);
    } else if (this.state !== 'gone') {
      this.alpha = lerp(this.alpha, 1, ta);
    }
  }

  step(dt, viewH) {
    const n = this.u.length;
    const { px, py, ox, oy, ax, ay } = this;

    switch (this.state) {
      case 'onFace':
        this.snapToAnchors();
        break;

      case 'peeling': {
        const tmp = { x: 0, y: 0 };
        const g = this.imageToScreen(this.grab.u, this.grab.v, tmp);
        const dx = this.pinch.x - g.x;
        const dy = this.pinch.y - g.y;
        this.pull = Math.hypot(dx, dy) / this.maskFaceHeight();
        const prog = Math.min(this.pull / PEEL.removePull, 1);

        // Stretch radius grows and face adhesion weakens as you pull.
        const radius = lerp(PEEL.falloffMin, PEEL.falloffMax, prog * prog);
        const detach = prog * prog * PEEL.globalDetach;
        const inv2r2 = 1 / (radius * radius);

        for (let k = 0; k < n; k++) {
          const du = this.u[k] - this.grab.u;
          const dv = this.v[k] - this.grab.v;
          const local = Math.exp(-(du * du + dv * dv) * inv2r2);
          const wk = local + (1 - local) * detach;
          this.w[k] = wk;
          const tx = ax[k] + dx * wk;
          const ty = ay[k] + dy * wk;
          // Near the fingers: follow tightly. Far away: a bit of rubbery lag.
          const follow = 1 - Math.exp(-(10 + 50 * wk) * dt);
          ox[k] = px[k];
          oy[k] = py[k];
          px[k] = lerp(px[k], tx, follow);
          py[k] = lerp(py[k], ty, follow);
        }
        this.pinGrabPoint();

        if (this.pull >= PEEL.removePull) {
          this.freezeRestLengths();
          this.setState('held');
        }
        break;
      }

      case 'returning': {
        let maxErr = 0;
        for (let k = 0; k < n; k++) {
          const vx = (px[k] - ox[k]) * PHYS.returnDamping;
          const vy = (py[k] - oy[k]) * PHYS.returnDamping;
          ox[k] = px[k];
          oy[k] = py[k];
          px[k] += vx + (ax[k] - px[k]) * PHYS.returnSpring;
          py[k] += vy + (ay[k] - py[k]) * PHYS.returnSpring;
          maxErr = Math.max(maxErr, Math.abs(ax[k] - px[k]) + Math.abs(ay[k] - py[k]));
          this.w[k] *= 0.9;
        }
        this.pull *= 0.9;
        if (maxErr < 1.5 || this.stateMs > 1500) {
          this.pull = 0;
          this.grab = null;
          this.setState('onFace');
          this.snapToAnchors();
        }
        break;
      }

      case 'held':
      case 'falling': {
        const g = PHYS.gravity * viewH * dt * dt;
        for (let k = 0; k < n; k++) {
          const vx = (px[k] - ox[k]) * PHYS.damping;
          const vy = (py[k] - oy[k]) * PHYS.damping;
          ox[k] = px[k];
          oy[k] = py[k];
          px[k] += vx;
          py[k] += vy + g;
        }
        if (SIMPLE_GRAB) this.matchShape(PHYS.shapeStiffness);
        for (let it = 0; it < PHYS.iterations; it++) {
          this.solveLinks();
          if (this.state === 'held') this.pinGrabPoint();
        }
        if (this.state === 'falling') {
          let minY = Infinity;
          for (let k = 0; k < n; k++) minY = Math.min(minY, py[k]);
          if (minY > viewH + 50) this.setState('gone');
        }
        break;
      }

      case 'gone':
        // No respawn in the current step-by-step build.
        if (!SIMPLE_GRAB && this.stateMs > PHYS.respawnMs) {
          // Put a fresh mask back on the face for another try.
          this.alpha = 0;
          this.grab = null;
          this.pull = 0;
          this.setState('onFace');
          this.snapToAnchors();
        }
        break;
    }
  }

  // ---------- Simple rigid grab (debug) ----------

  /** Generous test: is pt anywhere inside the PNG's rectangle? */
  isInside(pt) {
    if (!pt || !this.hasPose) return false;
    const q = this.toImageSpace(pt);
    return q.x >= 0 && q.x <= this.image.width && q.y >= 0 && q.y <= this.image.height;
  }

  simpleUpdate(input, dtMs) {
    this.inside = this.isInside(input.pinchPoint);
    if (input.pinchPoint) this.pinch = { ...input.pinchPoint };

    if (this.state === 'onFace' && input.pinching && this.inside) {
      // Remember which image point is under the fingers; it stays under them.
      this.grab = this.makeGrab(this.toImageSpace(input.pinchPoint));
      this.setState('rigidGrab');
    } else if (this.state === 'rigidGrab' && !input.pinching) {
      this.grab = null;
      this.setState('onFace');
    } else if (this.state === 'held' && !input.pinching) {
      this.setState('falling');
    }

    const ta = 1 - Math.exp((-12 * dtMs) / 1000);
    const visible = this.state !== 'onFace' || this.lostMs < LOST_FADE_MS;
    this.alpha = lerp(this.alpha, visible ? 1 : 0, ta);
  }

  /** STEP 2: detach from the face and become a soft body hanging from the pinch. */
  popOff() {
    // Rest shape = the mask's shape on the face; the stretched region snaps
    // back toward it (the "pop"), then gravity takes over.
    this.freezeRestLengths();
    this.restX = Float32Array.from(this.ax);
    this.restY = Float32Array.from(this.ay);
    this.ox.set(this.px);
    this.oy.set(this.py);
    this.accum = 0;
    this.setState('held');
  }

  /**
   * STEP 1 deformation. Each vertex = face anchor + offset. While grabbed, the
   * offset moves toward (hand − grabbed anchor) × falloff, so the grabbed area
   * follows the fingers and the rest stays on the face. After release the
   * offsets relax to zero. Face tracking itself is never smoothed here.
   */
  stretchStep(dtMs) {
    const dt = dtMs / 1000;
    const n = this.u.length;
    const { ax, ay, px, py, offX, offY, w } = this;

    if (this.state === 'rigidGrab') {
      const g = this.imageToScreen(this.grab.u, this.grab.v, { x: 0, y: 0 });
      const dx = this.pinch.x - g.x;
      const dy = this.pinch.y - g.y;
      this.pull = Math.hypot(dx, dy) / this.maskFaceHeight();
      const inv = 1 / (STRETCH.radius * STRETCH.radius);
      for (let k = 0; k < n; k++) {
        const du = this.u[k] - this.grab.u;
        const dv = this.v[k] - this.grab.v;
        const wk = Math.exp(-(du * du + dv * dv) * inv);
        w[k] = wk;
        const t = 1 - Math.exp(-lerp(STRETCH.followFar, STRETCH.followNear, wk) * dt);
        offX[k] = lerp(offX[k], dx * wk, t);
        offY[k] = lerp(offY[k], dy * wk, t);
        px[k] = ax[k] + offX[k];
        py[k] = ay[k] + offY[k];
      }
      // Exact grabbed point sits between the fingers.
      this.pinGrabPoint();
      for (const k of this.grab.corners) {
        offX[k] = px[k] - ax[k];
        offY[k] = py[k] - ay[k];
      }
    } else {
      this.pull = 0;
      const t = 1 - Math.exp(-STRETCH.releaseRate * dt);
      for (let k = 0; k < n; k++) {
        offX[k] = lerp(offX[k], 0, t);
        offY[k] = lerp(offY[k], 0, t);
        w[k] = lerp(w[k], 0, t);
        px[k] = ax[k] + offX[k];
        py[k] = ay[k] + offY[k];
      }
    }
  }

  drawSimpleDebug(ctx, dpr) {
    // Mask rectangle = grab area
    const tmp = { x: 0, y: 0 };
    const W = this.image.width;
    const H = this.image.height;
    const o = { x: 0, y: 0 };
    ctx.save();
    ctx.strokeStyle = this.inside ? '#00ff66' : '#ff00ff';
    ctx.lineWidth = 3 * dpr;
    ctx.setLineDash([10 * dpr, 6 * dpr]);
    ctx.beginPath();
    [[0, 0], [W, 0], [W, H], [0, H]].forEach(([u, v], i) => {
      this.imageToScreen(u, v, tmp);
      i ? ctx.lineTo(tmp.x + o.x, tmp.y + o.y) : ctx.moveTo(tmp.x + o.x, tmp.y + o.y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // ---------- Rendering ----------

  draw(ctx) {
    if (!this.hasPose || this.alpha < 0.01 || this.state === 'gone') return;
    const img = this.image;
    const { px, py, u, v, nx } = this;
    ctx.save();
    ctx.globalAlpha = this.alpha;
    for (const [i, j] of this.cells) {
      const k00 = j * nx + i;
      const k10 = k00 + 1;
      const k01 = k00 + nx;
      const k11 = k01 + 1;
      drawTriangle(ctx, img, px, py, u, v, k00, k10, k11);
      drawTriangle(ctx, img, px, py, u, v, k00, k11, k01);
    }
    ctx.restore();
  }

  drawDebug(ctx, dpr) {
    if (!this.hasPose || this.state === 'gone') return;
    if (SIMPLE_GRAB && (this.state === 'onFace' || this.state === 'rigidGrab')) this.drawSimpleDebug(ctx, dpr);
    const { px, py, nx, ny } = this;

    // Mesh wireframe, colored by how strongly each vertex follows the hand.
    ctx.lineWidth = 1 * dpr;
    for (const [i, j] of this.cells) {
      const k = j * nx + i;
      const wv = Math.min(1, this.w[k]);
      ctx.strokeStyle = `rgba(${Math.round(255 * wv)}, ${Math.round(220 * (1 - wv))}, 255, ${0.45 + 0.5 * wv})`;
      ctx.beginPath();
      ctx.moveTo(px[k], py[k]);
      ctx.lineTo(px[k + 1], py[k + 1]);
      ctx.lineTo(px[k + nx + 1], py[k + nx + 1]);
      ctx.lineTo(px[k + nx], py[k + nx]);
      ctx.closePath();
      ctx.stroke();
    }

    // Grab area (where a pinch can grab) — only meaningful when on the face.
    if (!SIMPLE_GRAB && (this.state === 'onFace' || this.state === 'returning')) {
      ctx.save();
      ctx.strokeStyle = '#ff00ff';
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      // Outline of the visible-cell region boundary approximated by the mesh hull.
      const corners = [0, nx - 1, nx * ny - 1, nx * (ny - 1)];
      corners.forEach((k, idx) => (idx ? ctx.lineTo(this.ax[k], this.ay[k]) : ctx.moveTo(this.ax[k], this.ay[k])));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // Grab point: where it is on the face vs. where the fingers hold it.
    if (this.grab && (this.state === 'rigidGrab' || this.state === 'peeling')) {
      const a = this.imageToScreen(this.grab.u, this.grab.v, { x: 0, y: 0 });
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(this.pinch.x, this.pinch.y);
      ctx.stroke();
      ctx.fillStyle = '#ffd400';
      ctx.beginPath();
      ctx.arc(a.x, a.y, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      // Removal threshold ring around the original grab spot
      {
        const ring = SIMPLE_GRAB ? STRETCH.removePull : PEEL.removePull;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.arc(a.x, a.y, ring * this.maskFaceHeight(), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
}

// Draws one textured triangle (vertex indices a, b, c) with an affine map
// from image space to screen space, clipped to the (slightly expanded) triangle.
function drawTriangle(ctx, img, px, py, u, v, a, b, c) {
  const x0 = px[a], y0 = py[a], x1 = px[b], y1 = py[b], x2 = px[c], y2 = py[c];
  const u0 = u[a], v0 = v[a], u1 = u[b], v1 = v[b], u2 = u[c], v2 = v[c];

  const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (Math.abs(det) < 1e-6) return;
  const ma = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
  const mb = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
  const mc = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
  const md = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
  const me = x0 - ma * u0 - mc * v0;
  const mf = y0 - mb * u0 - md * v0;

  // Expand the clip triangle ~1px outward to hide seams between triangles.
  const cx = (x0 + x1 + x2) / 3;
  const cy = (y0 + y1 + y2) / 3;
  const grow = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return [x + (dx / d) * 1.2, y + (dy / d) * 1.2];
  };
  const [ex0, ey0] = grow(x0, y0);
  const [ex1, ey1] = grow(x1, y1);
  const [ex2, ey2] = grow(x2, y2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ex0, ey0);
  ctx.lineTo(ex1, ey1);
  ctx.lineTo(ex2, ey2);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(ma, mb, mc, md, me, mf);
  // Only draw the source region around this triangle (+ padding for the expanded clip).
  const pad = 6;
  const sx = Math.max(0, Math.min(u0, u1, u2) - pad);
  const sy = Math.max(0, Math.min(v0, v1, v2) - pad);
  const sw = Math.min(img.width, Math.max(u0, u1, u2) + pad) - sx;
  const sh = Math.min(img.height, Math.max(v0, v1, v2) + pad) - sy;
  ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
  ctx.restore();
}
