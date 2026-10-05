import './style.css';
import { createFaceTracker, computeFace, drawFaceDebug } from './faceTracking.js';
import { Mask, STRETCH, loadImage, artFromAlpha } from './mask.js';
import { MONSTERS, DEFAULT_MONSTER_ID, getMonster } from './monsters.js';
import { createHandTracker, HandState, PINCH_ON, PINCH_OFF } from './handTracking.js';

const DEBUG = false;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');

// Mapping from video pixels to canvas pixels ("cover" fit). Recomputed on resize.
// Later phases use this to convert normalized landmarks to screen coords.
const view = { scale: 1, offsetX: 0, offsetY: 0 };

// Shared tracking state
let faceTracker = null;
let face = null; // { center, width, height, roll, yaw, pitch, points, ... } or null
let lastVideoTime = -1;

let mask = null; // created once the PNG loads

// ----- Monster selection: one Mask system, the PNG texture is swappable -----
const MONSTER_KEY = 'unmasked.monster';
let selectedMonsterId = DEFAULT_MONSTER_ID;
let activeMonsterId = null; // monster the current `mask` was built from
const monsterCache = new Map(); // id → Promise<{ image, art }>

function loadMonster(monster) {
  if (!monsterCache.has(monster.id)) {
    const p = loadImage(monster.src).then((image) => ({ image, art: monster.art || artFromAlpha(image) }));
    p.catch(() => monsterCache.delete(monster.id)); // allow retry if the file is added later
    monsterCache.set(monster.id, p);
  }
  return monsterCache.get(monster.id);
}

/** Builds the mask from the selected monster (same Mask class, new texture). */
async function useSelectedMonster() {
  const monster = getMonster(selectedMonsterId);
  const { image, art } = await loadMonster(monster);
  mask = new Mask(image, art);
  activeMonsterId = monster.id;
}

// ----- Player name (kept only in this browser session) -----
const NAME_MAX = 16;
const NAME_KEY = 'unmasked.playerName';
let playerName = '';

function cleanName(raw) {
  return raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

// ----- Reveal (banner + audio), fired once when the mask is removed -----
const revealEl = document.getElementById('reveal');
const revealTextEl = document.getElementById('reveal-text');
const frameWrap = document.querySelector('.frame-wrap');
const revealAudio = new Audio('/audio/scooby_reveal_3m06_to_3m10.mp3');
revealAudio.preload = 'auto';
let revealed = false;

function setRevealText() {
  const text = `THE MONSTER WAS ${playerName.toUpperCase()} ALL ALONG!`;
  revealTextEl.textContent = text;
  // Shrink the banner text for long names so it never overruns the layout.
  revealEl.style.setProperty('--fit', Math.min(1, 31 / text.length).toFixed(3));
}

function triggerReveal() {
  revealed = true;
  setRevealText();
  revealEl.classList.add('show');
  frameWrap.classList.add('revealed');
  revealAudio.currentTime = 0;
  revealAudio.play().catch((err) => {
    // Chrome blocks audio until the page has had a click/keypress.
    console.warn('Reveal audio blocked:', err.message);
  });
}

function resetReveal() {
  revealed = false;
  revealEl.classList.remove('show');
  frameWrap.classList.remove('revealed');
  revealAudio.pause();
  revealAudio.currentTime = 0;
}
let handTracker = null;
const hand = new HandState(); // hand.hand, hand.pinching, hand.pinchPoint
let wasPinching = false;
let pinching = false; // hand pinch OR space bar
// DEBUG fallback: holding SPACE acts as a pinch at the thumb/index midpoint.
let spaceHeld = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.closest?.('input, textarea')) {
    spaceHeld = true;
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false;
});
window.addEventListener('blur', () => (spaceHeld = false));
let pinchPoint = null; // smoothed pinch point, updated every render frame

// Normalized video landmark -> mirrored canvas pixel coords.
function toScreen(lm) {
  return {
    x: canvas.width - (lm.x * video.videoWidth * view.scale + view.offsetX),
    y: lm.y * video.videoHeight * view.scale + view.offsetY,
  };
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.toggle('hidden', !text);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  // Canvas fills its frame (layout only; the landmark mapping uses canvas.width/height).
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  updateView();
}

function updateView() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  view.scale = Math.max(canvas.width / vw, canvas.height / vh);
  view.offsetX = (canvas.width - vw * view.scale) / 2;
  view.offsetY = (canvas.height - vh * view.scale) / 2;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia is not supported in this browser.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((resolve) => (video.onloadedmetadata = resolve));
  await video.play();
}

// FPS counter
let lastFrameTime = performance.now();
let fps = 0;

function drawVideo() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  // Mirror horizontally like a selfie camera.
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, view.offsetX, view.offsetY, vw * view.scale, vh * view.scale);
  ctx.restore();
}

let lastDetectTime = 0;

function detect(now) {
  // Only run detection when the camera produced a new frame.
  if (!faceTracker || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const sinceLast = lastDetectTime ? now - lastDetectTime : 0;
  lastDetectTime = now;
  face = computeFace(faceTracker.detectForVideo(video, now), toScreen);
  if (handTracker) hand.update(handTracker.detectForVideo(video, now), toScreen, sinceLast);
}

function drawDebug() {
  const dpr = window.devicePixelRatio || 1;
  if (face) drawFaceDebug(ctx, face, dpr);
  mask?.drawDebug(ctx, dpr);
  hand.drawDebug(ctx, dpr);

  const deg = (r) => ((r * 180) / Math.PI).toFixed(0);
  const lines = [
    `FPS: ${fps.toFixed(0)}`,
    face
      ? `face: ${face.center.x.toFixed(0)},${face.center.y.toFixed(0)}  ${face.width.toFixed(0)}x${face.height.toFixed(0)}`
      : 'face: none',
    face ? `roll: ${deg(face.roll)}°  yaw: ${face.yaw.toFixed(2)}  pitch: ${face.pitch.toFixed(2)}` : '',
    hand.hand
      ? `pinch dist 2D: ${hand.hand.ratio2d.toFixed(2)}  (3D: ${hand.hand.ratio3d?.toFixed(2) ?? '-'})`
      : 'hand: none',
    `PINCH: ${pinching ? 'YES' : 'NO'}${spaceHeld ? ' [SPACE]' : ''}   (2D on < ${PINCH_ON}, off > ${PINCH_OFF})`,
    pinchPoint ? `pinch X/Y: ${pinchPoint.x.toFixed(0)}, ${pinchPoint.y.toFixed(0)}` : 'pinch X/Y: -',
    `INSIDE MASK: ${mask?.inside ? 'YES' : 'NO'}`,
    `GRABBED: ${mask?.grabbed ? 'YES' : 'NO'}   mask: ${mask?.state ?? 'loading'}`,
    mask ? `pull: ${mask.pull.toFixed(2)} / ${STRETCH.removePull}   REMOVED: ${mask.removed ? 'YES' : 'NO'}` : '',
  ].filter(Boolean);

  const fs = 14 * dpr;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(10 * dpr, 10 * dpr, 520 * dpr, (lines.length * 20 + 12) * dpr);
  ctx.fillStyle = '#0f0';
  ctx.font = `${fs}px monospace`;
  lines.forEach((line, i) => ctx.fillText(line, 20 * dpr, (30 + i * 20) * dpr));

  // Big pinch-point circle: grey = no pinch, red = pinch outside, green = inside, yellow = grabbed.
  if (pinchPoint && hand.hand) {
    let color = 'rgba(200,200,200,0.8)';
    if (mask?.grabbed) color = '#ffd400';
    else if (pinching) color = mask?.inside ? '#00ff66' : '#ff3030';
    else if (mask?.inside) color = 'rgba(0,255,102,0.5)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 5 * dpr;
    ctx.beginPath();
    ctx.arc(pinchPoint.x, pinchPoint.y, 34 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pinchPoint.x, pinchPoint.y, 8 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  if (mask?.grabbed) {
    ctx.font = `bold ${72 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 8 * dpr;
    ctx.strokeStyle = '#000';
    ctx.strokeText('GRABBED', canvas.width / 2, 110 * dpr);
    ctx.fillStyle = '#ffd400';
    ctx.fillText('GRABBED', canvas.width / 2, 110 * dpr);
    ctx.textAlign = 'left';
  }
}

// Smooths the pinch point between (30fps) detections so the held mask moves fluidly.
function updatePinch(dt) {
  const target = hand.pinchPoint;
  if (!target) return;
  if (!pinchPoint || (pinching && !wasPinching)) {
    pinchPoint = { ...target };
    return;
  }
  const t = 1 - Math.exp((-35 * dt) / 1000);
  pinchPoint.x += (target.x - pinchPoint.x) * t;
  pinchPoint.y += (target.y - pinchPoint.y) * t;
}

// Single render loop: detect -> draw video -> draw overlays.
function loop(now) {
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;

  if (video.readyState >= 2) {
    detect(now);
    pinching = hand.pinching || (spaceHeld && !!pinchPoint);
    updatePinch(dt);
    mask?.update(face, Math.min(dt, 100), { pinching, pinchStarted: pinching && !wasPinching, pinchPoint }, canvas.height);
    wasPinching = pinching;
    if (mask && !revealed && mask.removed && !document.body.classList.contains('mode-intro')) triggerReveal();
    drawVideo();
    mask?.draw(ctx);
    if (DEBUG) drawDebug();
  }
  requestAnimationFrame(loop);
}

async function init() {
  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    if (err.name === 'NotAllowedError') {
      setStatus('Camera permission denied. Allow camera access in Chrome (address bar → camera icon) and reload.');
    } else if (err.name === 'NotFoundError') {
      setStatus('No camera found.');
    } else {
      setStatus(`Could not start camera: ${err.message}`);
    }
    return;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  requestAnimationFrame(loop); // show camera immediately while the model loads

  setStatus('Loading face & hand tracking…');
  try {
    const [fTracker, hTracker] = await Promise.all([
      createFaceTracker(),
      createHandTracker(),
      useSelectedMonster(),
    ]);
    faceTracker = fTracker;
    handTracker = hTracker;
    const resetBtn = document.getElementById('reset-btn');
    resetBtn.addEventListener('click', () => {
      mask.reset();
      resetReveal();
      resetBtn.blur(); // so the Space debug key can't re-trigger the button
    });
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load: ${err.message}`);
  }
}

// ----- Intro screen: name entry → start the experience -----
const introForm = document.getElementById('intro');
const nameInput = document.getElementById('name-input');
const nameError = document.getElementById('name-error');
let started = false;

try {
  nameInput.value = sessionStorage.getItem(NAME_KEY) || '';
} catch {
  /* storage unavailable — just start empty */
}

function showIntro() {
  document.body.classList.add('mode-intro');
  nameError.textContent = '';
  nameInput.focus();
  nameInput.select();
}

introForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = cleanName(nameInput.value);
  if (!name) {
    nameError.textContent = 'Every mystery needs a name!';
    introForm.classList.remove('shake');
    void introForm.offsetWidth; // restart the shake animation
    introForm.classList.add('shake');
    nameInput.focus();
    return;
  }
  playerName = name;
  nameInput.value = name;
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  document.body.classList.remove('mode-intro');
  nameInput.blur();

  if (!started) {
    started = true;
    init(); // first time: request the camera and load tracking
  } else {
    // New player on an already-running camera: fresh mask, reveal cleared.
    resizeCanvas();
    resetReveal();
    if (mask && activeMonsterId !== selectedMonsterId) {
      useSelectedMonster().catch((err) => console.error(err));
    } else {
      mask?.reset();
    }
  }
});

// Monster cards
const monsterGrid = document.getElementById('monster-grid');

try {
  const saved = sessionStorage.getItem(MONSTER_KEY);
  if (saved && MONSTERS.some((m) => m.id === saved)) selectedMonsterId = saved;
} catch {
  /* ignore */
}

function selectMonster(id) {
  selectedMonsterId = id;
  try {
    sessionStorage.setItem(MONSTER_KEY, id);
  } catch {
    /* ignore */
  }
  for (const card of monsterGrid.children) {
    const on = card.dataset.id === id;
    card.classList.toggle('selected', on);
    card.setAttribute('aria-checked', String(on));
  }
}

for (const monster of MONSTERS) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'monster-card';
  card.dataset.id = monster.id;
  card.setAttribute('role', 'radio');
  const img = document.createElement('img');
  img.src = monster.src;
  img.alt = '';
  const label = document.createElement('span');
  label.className = 'monster-name';
  label.textContent = monster.name;
  card.append(img, label);
  // PNG not in the project yet → show a locked card; fall back to the default.
  img.addEventListener('error', () => {
    card.classList.add('missing');
    card.disabled = true;
    label.textContent = 'COMING SOON';
    if (selectedMonsterId === monster.id) selectMonster(DEFAULT_MONSTER_ID);
  });
  card.addEventListener('click', () => selectMonster(monster.id));
  monsterGrid.append(card);
}
selectMonster(selectedMonsterId);

nameInput.addEventListener('input', () => (nameError.textContent = ''));

document.getElementById('change-name-btn').addEventListener('click', (e) => {
  e.currentTarget.blur();
  showIntro();
});

showIntro();
