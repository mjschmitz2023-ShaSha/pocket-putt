# Orbit — Course Design Spec

**Status:** Design freeze (grilled + confirmed)  
**Course id:** `orbit`  
**Display name:** Orbit  
**Hole count:** 19  
**Placement:** Fourth course in the picker (after Classic, Canyon Jumps, Goo Lagoon)

This document is the authoritative design for the Orbit pack. Implementation should not invent assist rails, alternate win conditions, or gravity laws that contradict this spec.

---

## 1. Fantasy

Orbit is about **real 2D gravity**: wells, planets, black holes, and slingshots. The player reads mass and geometry, not hidden boosts.

**Non-goals**

- Fake 3D (ramps break planar gravity).
- Secret guide rails, authored velocity curves, or invisible “HOIO lanes.”
- Winning by falling into a black hole (the cup is always a normal cup).

---

## 2. Curriculum (19 holes)

| Band | Holes | Intent |
|------|-------|--------|
| Teach | 1–4 | One body, readable pull, simple bounce / avoid horizon |
| Puzzle | 5–12 | Two (occasionally three) bodies, slingshot lines, sand/water texture |
| Spectacle | 13–19 | Layout drama still within body budget; **19 = moon finale** |

Scoring stays the global game rules (strokes, time, multiplayer standings). No Orbit-specific score formula.

---

## 3. Gravity law

### 3.1 Force

- Continuous Newtonian field:  
  \(\mathbf{a} = G M \,\hat{\mathbf{r}} / r^{2}\)
- **Global** gravitational constant `G`.
- **Per-body** `mass` `M` (tune by feel; tests enforce escape and HOIO).
- **ε = 0** in the force law. Softening is unnecessary if fields are never evaluated inside a body.

### 3.2 Where the field applies

| Region | Behavior |
|--------|----------|
| Outside solid radius / horizon | Apply \(1/r^{2}\) pull toward body center |
| Inside planet disk | **No field sample** — collision owns contact |
| Inside black-hole horizon | **No field sample** — capture owns the event |

Optional designer **`fieldRadius` (SOI)** may cut off integration for \(r > R_{\mathrm{field}}\) so “free space” is readable and tests have a clear exterior. That cutoff is a finite domain for the same \(1/r^{2}\) law, not a second force model or a guide rail.

### 3.3 Authoring knobs

- Expose **`G`** (global) and **`mass`** (per body).
- Designers tune mass until it feels right.
- Guardrails are **math + unit tests** (escape velocity, HOIO seeds), not a second surface-g UI.

### 3.4 Multi-body budget

- At most **3 static attractors** per hole (planets + black holes count).
- Holes 1–4: prefer **1** body.
- Holes 5–18: **2–3** bodies.
- Hole 19: **moving moon** ± one static body.

---

## 4. Bodies

### 4.1 Planet

| Property | Spec |
|----------|------|
| Role | Primary slingshot / bank body |
| Solid | Circular collider, radius `R` |
| Bounce | **Wall-like restitution (0.8)** — not bumper 1.05 |
| Rest on crust | **Legal lie** (like against a wall). Full putt power. Fighting gravity is the tax. |
| Escape rule | From the surface, **max launch must be able to escape**. If not, mass/`G`/`R` is wrong. |
| Escape math | At contact radius \(r = R_{\mathrm{planet}} + R_{\mathrm{ball}}\),  
  \(v_{\mathrm{esc}} = \sqrt{2 G M / r}\). Require \(v_{\mathrm{esc}} < v_{\max}\) with margin (`MAX_LAUNCH_SPEED` = 950 today). |

Bad graze should **die onto the crust**, not pinball forever. Implementation may need a stable resting-contact policy under continuous pull so micro-bounce chatter does not fight the design intent.

### 4.2 Black hole

| Property | Spec |
|----------|------|
| Role | Signature hazard + dangerous slingshot mass |
| Exterior | **Does pull** — mass + horizon (not capture-only paint) |
| Mass | **Higher than typical planets**, body **much smaller** |
| Visual size | **Visibly smaller than the cup** (cup radius is 11 logical px today) |
| Horizon | Enter → **capture** |
| Penalty | **+1 stroke**, full stop, **reset to this hole’s tee/spawn** (not a custom drop pad) |
| Wet | **No** — wet stays a water/goo interaction elsewhere |
| Win condition | **Never** — cup is always the score target |

`drawRadius` may be smaller than `horizonRadius` if the art needs a denser dot while the hitbox stays fair for `BALL_RADIUS`.

### 4.3 Moon (hole 19 only)

| Property | Spec |
|----------|------|
| Type | Moving **planet** (same bounce / mass / field rules) |
| Motion | **Circular orbit** around a fixed center (static planet or empty barycenter) |
| Sync | Phase from **absolute sim tick** (same idea as `setHoleObstaclesAtTick`) so host/client never drift |
| HOIO witness | Stores **drag + start tick/phase** |
| Neighborhood | Jitters **aim/power only** — **not** phase (player waits for the window) |

---

## 5. Allowed level toys

### 5.1 Allowed

- Boundary walls + interior **walls**
- **Sand**
- **Water** (existing drop-pad + stroke rules; may still apply wet if water code does — Orbit should not rely on goo)
- **Boost pads** (sparse “thrusters”; must not become fake gravity highways)
- **Planets**, **black holes**, normal **cup** + existing **cup magnet** (Classic divot)

### 5.2 Banned on Orbit

- **Ramps** (fake 3D / airborne breaks planar gravity fantasy)
- **Windmills**
- **Pendulums**
- **Sliding gates**
- **Sticky goo**
- **Assist rails** / invisible redirect volumes / authored free-path polylines

### 5.3 Cup magnet

- **Keep Classic cup magnet** on Orbit holes (`CUP_GRAVITY_*` as today).
- Do not disable cup gravity solely because fields exist. Placement and mass tuning own interactions with nearby black holes.

---

## 6. Hazard comparison

| Hazard | Stroke | Respawn |
|--------|--------|---------|
| Water | +1 | Designer **drop point** |
| Black hole | +1 | **Hole tee only** |
| Sand | — | Friction only |
| Planet surface rest | — | Play it as a lie |

---

## 7. Hole-in-one verification

**Constraint:** Every Orbit hole must be **hole-in-one capable**, proven in automated tests.

### 7.1 Why two mechanisms

| Concern | Guard |
|---------|--------|
| Client/server fork | Single authority physics in `shared.js`; optional lockstep host/client check on the ace seed |
| Brittle golden path | Microcloud + majority around a stored seed |

The sim is **deterministic**: identical inputs always produce the same path. “Majority of identical runs” is meaningless. Majority applies to a **tight cloud** of nearby inputs.

### 7.2 Seed file (committed)

Per hole, store at least:

- `holeIndex` (or hole name/id)
- Exact **aim + power** (or equivalent `dragVector`)
- Hole 19: **`startTick` / phase** for the moon
- Optional metadata: author note, expected sim ticks

Produced offline by a finder tool or hand-authored play; **not** by a live optimizer in CI.

### 7.3 CI procedure

1. **Seed must HIO** from tee under authority `stepBallPhysics` (host rules).
2. Build a **microcloud** around the seed (very narrow aim/power jitter — stability, not “easy for humans”).
3. **Pass** if a **majority** of cloud samples also HIO (and seed HIO).
4. Fail if any required sample: fails to hole, hits water/BH before cup, or exceeds sim timeout (recommend 15–20s of ticks).
5. Hole 19: fix phase from witness; **do not** jitter phase in the cloud.
6. **No trivial horizontal ace:** for every hole, a full-power pure horizontal putt (drag `(-MAX_DRAG_DIST, 0)` → launch pure +x at `MAX_LAUNCH_SPEED`) must **not** HIO. Blocks “hold full power and release with no aim.”
7. **Sibling check (recommended):** same seed on host `GameSession` + client model lockstep still holes with negligible pose error (catches recon/physics forks).

### 7.4 Escape-velocity tests (planets)

For each planet body in the pack (or each hole’s planets):

- Place ball at rest on the crust at several sample angles.
- Apply **max launch** in the anti-radial direction (and/or assert \(v_{\mathrm{esc}} < MAX\_LAUNCH \times margin\) analytically).
- Require successful departure to free space / outside SOI without black-hole capture.

If escape fails, the body tuning is illegal — fix mass/`G`/`R`, not the player.

### 7.5 Suggested layout

```
test/orbit-aces.json          # committed seeds
test/orbit-hio.js             # replay + microcloud + majority
# optional: npm run find-orbit-ace — offline search helper
```

Wire into `npm test` alongside sticky/rubberband suites.

---

## 8. Multiplayer

- Gravity and body motion live only in **shared** physics so host and client cannot disagree about the law.
- Moon phase is a pure function of **sim tick** (no wall-clock integration of ω).
- Coast netcode unchanged in spirit: `puttApplied` impulse + local integrate + sparse hard corrections.
- Soft mid-flight pose/velocity rewrites remain forbidden (existing recon rules).
- Black-hole capture is a **discrete hard event** (like water): authority snap + tee reset.

---

## 9. Data sketch (non-normative field names)

Implementation may rename fields; semantics must match.

```js
// Course
{ id: 'orbit', name: 'Orbit', holes: ORBIT_HOLES }

// Hole (in addition to classic arrays: walls, sand, water, boost, cup, tee, par, …)
{
  name: 'Aphelion Drill',
  par: 2,
  tee: { x, y },
  cup: { x, y, radius: 11 },
  walls: [ /* … */ ],
  sand: [ /* … */ ],
  water: [ /* … */ ],
  boost: [ /* sparse */ ],
  pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
  gravityBodies: [
    {
      kind: 'planet',       // or 'blackHole' | 'moon'
      x, y,                 // center (moon: orbit center is separate)
      radius: 28,           // solid / horizon radius
      mass: 4.2e6,
      fieldRadius: 180,     // optional SOI cutoff
      // moon only:
      // orbitRadius, orbitPeriodTicks, orbitCenter: {x,y}
    },
  ],
}
```

Empty classic arrays remain present so render/physics loops stay uniform.

---

## 10. Implementation outline (suggested order)

1. **Shared physics:** body list, \(1/r^{2}\) integrate per subtick, planet circle collision @ 0.8, BH capture → tee + stroke.
2. **Constants:** `G`, `PLANET_RESTITUTION = WALL_RESTITUTION` (0.8), defaults/docs for mass scale.
3. **Escape unit tests** on synthetic planets before packing holes.
4. **Orbit course shell:** 19 hole stubs + course registration + UI picker.
5. **Curriculum fill** holes 1–4 → mid → late; boosts only when needed.
6. **Ace seeds + microcloud CI** as holes land (do not merge a hole without a seed).
7. **Hole 19 moon** + phase-locked ace witness.
8. **Render:** planets, BH (tiny dense core + horizon read), moon; course atlas entry.
9. **MP smoke:** lockstep on a 2-body slingshot + BH capture hard event.

---

## 11. Open parameters (not frozen)

These are implementation/tuning choices, not design identity:

- Numeric value of `G` and example masses  
- Default `fieldRadius` heuristic  
- Microcloud half-widths (aim degrees, power %) and exact majority threshold (e.g. >50% of N)  
- Sim timeout ticks for HIO tests  
- Escape margin factor (e.g. \(v_{\mathrm{esc}} \le 0.85 \times 950\))  
- Art/palette, particles, audio  
- Per-hole par numbers  

When tuned, record chosen defaults in this doc or in code comments next to constants.

---

## 12. Decision log (grill)

| # | Decision |
|---|----------|
| 1 | Hybrid gravity: continuous fields + discrete BH capture; **no assist rails** |
| 2 | 19 holes, curriculum bands, **normal cups only** |
| 3 | Planets bounce; BH swallow; moon on **19 only** |
| 4 | Planet contact = solid bounce (wall-like), not field-only wells |
| 5 | BH: +1 stroke, **reset to tee** |
| 6 | Force law \(1/r^{2}\), ε = 0; no field inside body |
| 7 | ≤3 static attractors per hole |
| 8 | HOIO: offline seed, CI microcloud + majority; lockstep for MP forks |
| 9–10 | Toys: walls/sand/water/boost; no ramps/windmills/pendulums/gates/goo |
| 11 | Planet restitution **0.8** (wall-like); rest on surface intended |
| 12 | Surface = legal lie; max putt must allow escape |
| 13–14 | Escape via **math**; authoring = global **G** + per-body **mass** |
| 15 | BH pulls outside horizon; **small, high mass**, smaller than cup |
| 16 | Cup magnet **on** |
| 17 | Moon circular, tick-locked; phase not jittered in tests |
| 18–19 | Narrow microcloud + majority; determinism vs MP called out separately |
| 20 | Course id/name **`orbit` / Orbit** |

---

## 13. Confirmation

Design freeze confirmed by product owner after grilling. Implementation should treat this file as the contract; material changes update this spec first.
