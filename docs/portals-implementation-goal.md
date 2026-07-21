# /goal objective — Valve-style portals (v1)

Paste everything under **OBJECTIVE** into:

```text
/goal <paste>
```

Or point the agent at this file and instruct it to execute the objective.

---

## OBJECTIVE

Implement Valve-style portals for Pocket Putt per the frozen design below. Work in the pocket-putt repo (`shared.js` physics, `draw.js`, `editor.js` / gizmos, LEVEL_CODEC, `game.js` audio/events). Do not invent alternate portal rules; follow the decision table exactly. Do not ship dual-sample gravity or a built-in portal course in v1. Report progress with `update_goal` as milestones complete. Mark the goal completed only when success criteria and tests pass.

### Frozen decisions (do not renegotiate)

| Topic | Choice |
|--------|--------|
| Pair count | Max **2** pairs |
| Colors (1 pair) | **Orange ↔ Blue** (runtime only; not stored) |
| Colors (2 pairs) | Coop: **Orange ↔ Red**, **Blue ↔ Purple** |
| Incomplete pairs | **Pairs only** — editor always places both ends; runtime never sees orphans |
| Attachment | Host kind + index + `t` (0..1 along segment) + shared width + face |
| Hosts | **wall**, **gate**, **pendulum** only (not windmills) |
| Width | Designer-tunable; **one width per pair**; clamp to both hosts; min ≥ ball diameter + margin |
| Same segment | Allowed if apertures **do not overlap** |
| Trigger | Center in aperture AND `v_rel · n > ε` AND grounded (`z≈0`) AND not sticky-latched |
| Collision | **Open hole** across aperture; solid remainder still collides |
| Velocity | Full rigid local-frame map (entry → exit, normal out of exit); **include surface velocity** |
| Anti ping-pong | **Exit offset only** (no cooldown): place at exit center + `n_exit * (BALL_RADIUS + epsilon)` |
| Gravity v1 | **World-space only** at real ball position |
| Hazards | World position only (no dual-sample sand/water/etc.) |
| Facing | Designer picks face (±1) |
| Visuals | Top-down **colored line segment** + **faint glow along face normal** (not in-plane). No see-through, no partner schematic |
| Audio | Vendor Portal 2 portalgun **entry/exit** WAVs from https://github.com/sourcesounds/portal2/tree/master/sound/weapons/portalgun into repo (e.g. `sounds/portal/`); play on teleport event. SFX only — no flash/shake/particles |
| Authoring | Editor + LEVEL_CODEC; **no** official portal pack |
| MP | Local sim + existing x/y/vx/vy corrections; no special portal packet |

### Data model

```js
// hole.portalPairs: length 0..2
{
  width: number,
  a: { host: 'wall'|'gate'|'pendulum', index: number, t: number, face: 1|-1 },
  b: { host: 'wall'|'gate'|'pendulum', index: number, t: number, face: 1|-1 },
}
```

- `normalizeHole` / `validateHole`: max 2 pairs, valid hosts/indices, face ±1, width clamp, min width, no overlapping apertures on same segment.
- Moving hosts: resolve segment each frame via existing `getSlidingGateSegment` / `getPendulumSegment`.
- LEVEL_CODEC **v4** (decode still accepts v1–v3); encode portalPairs tightly; cap at 2 pairs.

### Physics (`stepBallPhysics` in `shared.js`)

1. Resolve each portal end → segment, tangent, face normal, surface velocity (gate svx/svy or pendulum point velocity at aperture).
2. Carve open apertures out of wall/gate/pendulum collision.
3. On valid trigger: map position through pair; map velocity in portal rest frames (subtract entry surface vel → basis map with normal flip → add exit surface vel); emit `{ type: 'portal', pairIndex, from: 'a'|'b' }`.
4. Do not change gravity sampling.

### Draw / audio / editor

- Draw colored aperture strokes + normal-side glow; colors from pair count rules.
- Wire portal SFX like existing putt sounds when the portal event fires.
- Editor: Portal pair tool (place A then B), shared width, face flip, gizmos for `t`/width, refuse 3rd pair, delete whole pair, live Test mode physics.

### Implementation order

1. Schema + aperture/frame/velocity helpers + normalize/validate + blankHole  
2. Codec v4  
3. Physics carve-out + teleport + events  
4. Draw  
5. Audio (download/vendor SFX + playback)  
6. Editor tool + gizmos + panel  
7. Tests (must pass before calling goal done)

### Tests required

- Frame map: 180° and 90° pairs preserve speed; directions map correctly  
- Surface velocity: rest relative to moving gate → exit inherits exit gate velocity  
- Open hole: passes aperture; collides solid remainder  
- Triggers: no teleport if sticky, z>0, outward velocity, or center outside width  
- Normalize: width clamp, max 2 pairs, overlap reject  
- Codec: round-trip portalPairs; old v3 links still decode  
- Editor structural: caps, face bit, pair-only placement  

### Non-goals (do not implement under this goal)

- Built-in portal course pack  
- Windmill-hosted portals  
- Dual-sample gravity (SOI / always / LOS) or dual-sample hazards  
- Recursive portal view or partner schematic  
- Portal gun / mid-round placement  
- More than two pairs  
- Re-entry cooldown  

### Success criteria (all required to complete)

1. Editor authors 1–2 complete pairs on walls/gates/pendulums with matched width and face control.  
2. Share/`?lvl=` round-trips portals (codec v4).  
3. Ball through pair keeps speed and correct orientation; movers add surface velocity.  
4. Aperture is an open hole; line + glow readable top-down.  
5. Entry/exit SFX fire on teleport.  
6. Sticky / airborne / incomplete-pair rules match the table.  
7. Gravity still world-only.  
8. Required tests above pass.

### Working notes

- Prefer extending existing patterns in `shared.js` (wall segments, gate/pendulum velocity, LEVEL_CODEC, event list from `stepBallPhysics`) over new frameworks.  
- Keep diffs focused; no drive-by refactors.  
- If exit-offset-only ping-pongs in practice, note it — do not add cooldown unless clearly necessary and documented.  
- Dual-sample gravity is explicitly **out of scope** for this goal.

### Follow-up: portal gravity prototype (post-v1)

Switchable dual-sample gravity for A/B feel (default still **off** / world-only):

| Mode | Behavior |
|------|----------|
| `off` | World sample only (v1) |
| `always` | Map ball through each eligible portal end, sample world g at virtual point, map accel back |
| `soi` | Same, but only when ball is within `PORTAL_GRAVITY_SOI_RADIUS` of entry center |
| `los` | Same, but only with geometric LOS (on enterable face, within aperture width, within `PORTAL_GRAVITY_LOS_MAX`) |

**Superseded (ship):** material-space BEM bake in `portal-gravity.js` (automatic when portals + mass or moving hosts). Dual-sample modes remain in Shared for tests only (`setPortalGravityMode`, default **off**). Editor **Portal g** dropdown removed.
