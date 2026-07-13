# Editor fidelity — Playwright / manual contracts (P6)

Layered suite definition of done (plan § Layered tests). Unit + structural run under `npm test`. Browser contracts below are **manual or Playwright** — not required for CI exit 0 until a browser harness is wired.

## Contracts

| ID | Contract | How to check |
|----|----------|--------------|
| PW1 | **Wall thickness band** | Open editor + game on same hole; walls look ~10px (not thin 3px sketch). Structural: `draw.js` `WALL_DRAW_WIDTH = 10`. |
| PW2 | **Mill animates in edit** | Place a windmill in Edit mode; arms rotate on the global clock without entering Test. |
| PW3 | **Test putt gravity** | Add a planet near the tee; enter Test; rest or gentle putt — ball accelerates into the well (matches `test/editor-test-physics.js`). |
| PW4 | **Drop gizmo** | Select water hazard; drag drop-point handle; `dropPoint` updates; Test water respawn uses new point. |
| PW5 | **Boost angle gizmo** | Select boost pad; drag angle arrow; `angle` changes; Test pad launches in new direction. |
| PW6 | **Ghost freeze** | In Test, mill spins while ball rests. On drag-aim: mill freezes and ghost is stable. Release putt: mill advances while ball rolls. |
| PW7 | **Snap** | Drag wall endpoint near another vertex: snaps; hold **Shift**: ortho constraint. |
| PW8 | **Relay serves editor** | `npm start` → `GET /editor.html`, `/draw.js`, `/editor-snap.js`, `/editor-gizmos.js` return 200. Covered by `test/relay-static-files.js`. |

## Manual light (plan)

1. Import **Classic** hole → side-by-side with game: grass, walls, cup, zones match.
2. Import **Orbit** hole → gravity lens / BH art matches game; Test gravity pulls.

## Optional Playwright sketch

If Chromium + `@playwright/test` (or `playwright`) are available:

```js
// not installed by default — sketch only
// open editor.html, assert canvas visible, mill angle changes over rAF frames
// via page.evaluate on hole.windmills[0].angle
```

Log any automated run under the implementer work dir when run ad-hoc; do not block `npm test` on browser install.

## Related automated coverage

| Pack | Automated test file |
|------|---------------------|
| P1 | `test/draw-shared.js` |
| P2 | `test/editor-phase.js` |
| P3 | `test/editor-snap.js` |
| P4 | `test/editor-gizmos.js` |
| P5 | `test/editor-test-physics.js` |
| P6 | `test/editor-fidelity-structural.js` + this doc |
