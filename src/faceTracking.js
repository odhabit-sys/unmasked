import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Key landmark indices (MediaPipe face mesh)
const LM = {
  forehead: 10,
  chin: 152,
  cheekA: 234, // subject's right cheek edge
  cheekB: 454, // subject's left cheek edge
  eyeA: 33, // subject's right eye outer corner
  eyeB: 263, // subject's left eye outer corner
  noseTip: 1,
};

let fileset = null;

export async function getVisionFileset() {
  if (!fileset) fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  return fileset;
}

export async function createFaceTracker() {
  const vision = await getVisionFileset();
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
  });
}

/**
 * Converts normalized landmarks to mirrored screen (canvas pixel) coords and
 * computes the face metrics the mask needs. Returns null if no face.
 * toScreen(lm) -> {x, y}
 */
export function computeFace(result, toScreen) {
  const lms = result?.faceLandmarks?.[0];
  if (!lms) return null;

  const points = lms.map(toScreen);
  const p = (i) => points[i];

  const forehead = p(LM.forehead);
  const chin = p(LM.chin);
  const cheekA = p(LM.cheekA);
  const cheekB = p(LM.cheekB);
  const nose = p(LM.noseTip);

  const width = Math.hypot(cheekB.x - cheekA.x, cheekB.y - cheekA.y);
  const height = Math.hypot(chin.x - forehead.x, chin.y - forehead.y);

  // Center: midpoint of the cheek-to-cheek and forehead-to-chin lines.
  const center = {
    x: (cheekA.x + cheekB.x + forehead.x + chin.x) / 4,
    y: (cheekA.y + cheekB.y + forehead.y + chin.y) / 4,
  };

  // Roll (in-plane tilt), in screen space. After mirroring, eyeB is on the
  // screen-left and eyeA on the screen-right, so this is ~0 when upright.
  const eyeL = p(LM.eyeB);
  const eyeR = p(LM.eyeA);
  const roll = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);

  // Yaw / pitch: rough estimate from nose offset relative to face center,
  // normalized to roughly -1..1. Positive yaw = nose toward screen-right.
  const cosR = Math.cos(-roll);
  const sinR = Math.sin(-roll);
  const dx = nose.x - center.x;
  const dy = nose.y - center.y;
  const localX = dx * cosR - dy * sinR;
  const localY = dx * sinR + dy * cosR;
  const yaw = localX / (width / 2);
  const pitch = localY / (height / 2);

  return { points, center, width, height, roll, yaw, pitch, forehead, chin, cheekA, cheekB, nose };
}

export function drawFaceDebug(ctx, face, dpr) {
  // All landmarks as tiny dots
  ctx.fillStyle = 'rgba(0,255,180,0.7)';
  const r = 1.2 * dpr;
  for (const pt of face.points) {
    ctx.fillRect(pt.x - r, pt.y - r, r * 2, r * 2);
  }

  // Key points
  ctx.fillStyle = '#ff3b6b';
  for (const pt of [face.forehead, face.chin, face.cheekA, face.cheekB, face.nose]) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Rotated bounding box
  ctx.save();
  ctx.translate(face.center.x, face.center.y);
  ctx.rotate(face.roll);
  ctx.strokeStyle = '#ffd400';
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(-face.width / 2, -face.height / 2, face.width, face.height);
  // Up axis
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -face.height / 2);
  ctx.stroke();
  ctx.restore();

  // Center
  ctx.fillStyle = '#ffd400';
  ctx.beginPath();
  ctx.arc(face.center.x, face.center.y, 6 * dpr, 0, Math.PI * 2);
  ctx.fill();
}
