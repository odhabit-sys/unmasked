import { DEFAULT_ART } from './mask.js';

// Selectable monsters. All of them use the same Mask (mesh + physics) — only
// the PNG texture and its face-fit measurements differ.
//
// `art` = where the face sits inside the PNG (image pixels). If omitted, it is
// estimated from the PNG's visible pixels when the mask loads.
export const MONSTERS = [
  {
    id: 'ghoul',
    name: 'GREEN GHOUL',
    src: `${import.meta.env.BASE_URL}monster-mask.png`,
    art: DEFAULT_ART,
  },
  {
    id: 'werewolf',
    name: 'WEREWOLF',
    src: `${import.meta.env.BASE_URL}monster-werewolf.png`,
    // Measured from monster-werewolf.png (1312×1199): eyes ≈ y 650, chin ≈ y 1150,
    // inner face (without ears) ≈ x 375–950. Fit is slightly tighter than the art
    // so the narrow jaw (which slants right) still covers a real chin; eyes ~42% down.
    art: { anchorX: 675, anchorY: 712, faceTop: 320, faceBottom: 1105, faceWidth: 540 },
  },
  {
    id: 'diver',
    name: 'SEA DIVER',
    src: `${import.meta.env.BASE_URL}monster-diver.png`,
    // Measured from monster-diver.png: dome above the forehead, porthole at eye level.
    art: { anchorX: 606, anchorY: 530, faceTop: 200, faceBottom: 860, faceWidth: 580 },
  },
];

export const DEFAULT_MONSTER_ID = MONSTERS[0].id;

export function getMonster(id) {
  return MONSTERS.find((m) => m.id === id) || MONSTERS[0];
}
