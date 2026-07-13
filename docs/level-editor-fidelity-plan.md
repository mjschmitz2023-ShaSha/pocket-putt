# Level editor fidelity plan (grilled)

Source of truth for implement → review → architect gate loops.

## Product decisions

1. **Rendering:** Shared `draw.js` (after `shared.js`) used by game + editor. WYSIWYG: walls 10px, real zone/boost/mover/gravity/BH lens art.
2. **Edit mode movers:** Animate on one global level clock. Per-object **phase offset** in UI + codec so sequences sync.
3. **Test mode:** Full physics while rolling; **freeze movers only while drag-aiming** (ghost trajectory); world clock runs while ball rests ready to putt. Gravity/boosts/sticky/BH all real.
4. **Snap:** Grid + vertices + edge midpoints; **Shift = ortho**.
5. **Gizmos:** Per-type handles (wall ends, rect resize, water drop drag, boost/ramp angle arrow, pendulum length/amplitude, gate amplitude, mill arm, planet/BH radii, moon orbit/phase).
6. **Done:** All checklist items + layered tests green. Relay still serves editor assets.

## Feature packs (implement one pack per loop unless noted)

| ID | Pack | Depends on |
|----|------|------------|
| **P1** | Extract `draw.js`; wire `game.js` + `editor.js`; structural test lineWidth 10 / no thin editor walls | — |
| **P2** | Edit-mode animate movers + global clock; per-object phase UI + encode/decode | P1 |
| **P3** | Snap: vertices, midpoints, Shift-ortho + pure tests | P1 |
| **P4** | Per-type gizmos (drop point, boost angle, resize, endpoints, …) | P1 |
| **P5** | Test mode: real physics loop + freeze-on-aim ghost; gravity works | P1, P2 |
| **P6** | Layered verification suite (unit + structural + playwright contracts) | P2–P5 |

## Layered tests (definition of done)

1. **Unit:** snap helpers; phase → pose; trajectory under gravity; freeze doesn’t advance mills while aiming.
2. **Structural:** `draw.js` in index + editor + relay STATIC_FILES; no editor-only 3px wall path.
3. **Playwright:** wall thickness band; mill angle changes in edit; Test putt near planet accelerates; drop handle moves `dropPoint`; boost gizmo changes `angle`.
4. **Manual light:** import Classic + Orbit hole, side-by-side look.

## Loop protocol

```
for pack in P1..P6:
  1. Architect writes complete 5-part spec for implementer
  2. Implementer subagent implements (worktree optional)
  3. Review subagent reviews diff against THIS plan + pack acceptance
  4. If review FAIL → implementer fix loop (max 2) with review notes
  5. If review PASS → Architect verifies: read key diff, run pack verification cmds, spot-check
  6. Architect marks pack done only after personal verification
```

Architect is final gate. Subagents do bulk iteration. No “done” without architect re-run of verification.

## Non-goals

Multi-hole courses, full timeline keyframes, offline production solo, golden screenshot AI.
