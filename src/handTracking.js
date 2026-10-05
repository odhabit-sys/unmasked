import { HandLandmarker } from '@mediapipe/tasks-vision';
import { getVisionFileset } from './faceTracking.js';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Pinch = 2D screen distance between thumb tip and index tip, divided by the
// visible hand size. Two values = hysteresis, avoids flicker.
// (3D world distance is still computed for debug, but proved unreliable.)
export const PINCH_ON = 0.5;
export const PINCH_OFF = 0.62;
// Keep the last pinch state briefly if tracking drops out for a few frames.
const LOST_GRACE_MS = 200;

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

// Bone connections for debug drawing
const CONNECTIONS = HandLandmarker.HAND_CONNECTIONS.map(({ start, end }) => [start, end]);

export async function createHandTracker() {
  const vision = await getVisionFileset();
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  });
}

/**
 * Tracks one hand + pinch state across frames.
 * After update(): hand = { points, thumb, index, pinchPoint, size, ratio2d, ratio3d } or null,
 * pinching = boolean, pinchPoint = last known pinch point.
 */
export class HandState {
  constructor() {
    this.hand = null;
    this.pinching = false;
    this.pinchPoint = null;
    this.lostMs = 0;
    this.smoothRatio = null;
  }

  update(result, toScreen, dtMs) {
    const lms = result?.landmarks?.[0];
    if (!lms) {
      this.hand = null;
      this.lostMs += dtMs;
      if (this.lostMs > LOST_GRACE_MS) {
        this.pinching = false;
        this.smoothRatio = null;
      }
      return;
    }
    this.lostMs = 0;

    const points = lms.map(toScreen);
    const thumb = points[THUMB_TIP];
    const index = points[INDEX_TIP];
    const d2 = (a, b) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);

    // Visible hand size: wrist→middle knuckle, or palm width (scaled to match)
    // when the hand is foreshortened — whichever is larger.
    const size = Math.max(d2(WRIST, MIDDLE_MCP), d2(INDEX_MCP, PINKY_MCP) * 1.25, 1);

    // 2D ratio — this controls the pinch.
    const raw2d = d2(THUMB_TIP, INDEX_TIP) / size;
    this.smoothRatio = this.smoothRatio == null ? raw2d : this.smoothRatio * 0.4 + raw2d * 0.6;
    const ratio2d = this.smoothRatio;
    this.pinching = this.pinching ? ratio2d < PINCH_OFF : ratio2d < PINCH_ON;

    // 3D world ratio — debug display only.
    const w = result.worldLandmarks?.[0];
    let ratio3d = null;
    if (w) {
      const d3 = (a, b) => Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y, w[a].z - w[b].z);
      ratio3d = d3(THUMB_TIP, INDEX_TIP) / Math.max(d3(WRIST, MIDDLE_MCP), 1e-6);
    }

    this.pinchPoint = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    this.hand = { points, thumb, index, size, ratio2d, ratio3d, pinchPoint: this.pinchPoint };
  }

  drawDebug(ctx, dpr) {
    const h = this.hand;
    if (!h) return;

    // Skeleton
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      ctx.moveTo(h.points[a].x, h.points[a].y);
      ctx.lineTo(h.points[b].x, h.points[b].y);
    }
    ctx.stroke();

    ctx.fillStyle = '#fff';
    for (const pt of h.points) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Thumb ↔ index line
    const color = this.pinching ? '#00ff66' : '#ff9900';
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(h.thumb.x, h.thumb.y);
    ctx.lineTo(h.index.x, h.index.y);
    ctx.stroke();

    // Thumb tip (blue) and index tip (red)
    for (const [pt, c] of [[h.thumb, '#2d7dff'], [h.index, '#ff2d55']]) {
      ctx.fillStyle = c;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 9 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Pinch point
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(h.pinchPoint.x, h.pinchPoint.y, (this.pinching ? 12 : 6) * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}
