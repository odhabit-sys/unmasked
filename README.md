<div align="center">

# 🎭 UNMASKED!

### What if you could actually pull the mask off a Scooby-Doo monster?

<br>

### [▶️ TRY IT YOURSELF](https://odhabit-sys.github.io/unmasked/)

**[odhabit-sys.github.io/unmasked](https://odhabit-sys.github.io/unmasked/)**

<sub>Best experienced on desktop Chrome with a webcam.</sub>

</div>

---

**Unmasked** is an interactive browser experiment inspired by the classic cartoon mystery reveal — the moment the gang grabs the monster and yanks the mask off.

Open it, and a monster mask snaps onto your face through your webcam. Reach up, **pinch it with your fingers**, and it stretches like rubber. Pull far enough and it pops off your face — then dangles from your fingers until you let it drop.

No app, no download. It all runs in your browser.

---

## 🔍 How it works

1. **Enter your name**
2. **Choose your monster** — Green Ghoul, Werewolf or Sea Diver
3. **Allow camera access**
4. **Pinch the mask** with your thumb and index finger
5. **Pull** until the mask comes off
6. **Get unmasked** — _"The monster was you all along!"_

Want another go? Hit **Reset Mask**. Someone else's turn? Hit **Change Name**.

---

## 🧪 What makes it work?

A few things happen at once, every frame:

- **Face tracking** — finds your face and follows its position, size and tilt, so the mask stays glued on as you move.
- **Hand & finger tracking** — follows your hand and the tips of your thumb and index finger.
- **Pinch detection** — notices when those two fingertips touch, and only grabs the mask if you pinch _on_ it.
- **A stretchy mesh** — the mask isn't one flat picture. It's split into a grid of small pieces, so the part you grab follows your fingers while the rest stays on your face and stretches in between.
- **Soft, floppy physics** — once it pops off, the mask behaves like a loose rubber sheet: it hangs from your fingers, sags with gravity, swings when you move, and falls when you let go.
- **Your browser's camera** — nothing is uploaded anywhere; the video never leaves your device.

---

## 🛠️ Built with

- **JavaScript** (vanilla — no framework)
- **[Vite](https://vite.dev/)** for development and builds
- **[MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)** — Face Landmarker & Hand Landmarker
- **HTML Canvas** for drawing the camera feed and the deformable mask
- **WebRTC `getUserMedia`** for webcam access
- **GitHub Pages + GitHub Actions** for hosting and automatic deploys

---

## 👻 Behind the project

This started as a fun experiment around one question:

> **Could a cartoon unmasking actually become an interactive camera effect?**

Not a filter that swaps your face for a monster's — a mask you can physically grab, stretch and rip off with your own hands. Getting it to _feel_ right (the stretch, the pop, the floppy hang) turned out to be the best part.

---

<details>
<summary><b>💻 Run it locally</b></summary>

<br>

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually `http://localhost:5173`) in Chrome and allow camera access.

</details>

---

**Unofficial fan project.** Unmasked is an independent, experimental project inspired by classic cartoon mystery reveals. It is not affiliated with, sponsored by or endorsed by Warner Bros., Hanna-Barbera or any rights holder. _Scooby-Doo_ and related names are trademarks of their respective owners.

**Made by Reda**
