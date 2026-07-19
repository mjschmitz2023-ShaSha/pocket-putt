# Hard-truth sync (Pocket Putt MP)

| Field | Value |
|-------|--------|
| **Status** | Law agreed 2026-07-18; implementation trimming toward this |
| **Supersedes** | Soft pose authority, ignore-maze as primary sync strategy |
| **Related** | `docs/mp-tick-stamped-inputs.md`, `docs/local-lag-test.md` |

---

## Goal

Everyone stays on the **same sim timeline**. Prefer intelligent host rewind + hard snapshots over soft blends, error decay, and client ignore heuristics.

---

## Law (client hard authority)

When a **hard** host snapshot arrives stamped as sim tick **H**:

1. **Seed** all local sim state from host@H (balls, floats, dunks, strokes, obstacles from tick / wire).
2. Set `mpSimTick = H`.
3. **Resim** pure physics H → client present (wall/epoch target or prior free-run tip).
4. **Result of that resim is sim truth.**

**Optimization (visual only):** if after (3) every ball matches what we already had at present (within a tiny band), restore the previous present pose/visual error so there is **no pop**. That is confirmation of a correct prediction — not a third physics mode and not “keep local when we disagree.”

```
disagree → keep host-resimmed present (hard correction)
agree    → keep prior present (no visual change)
```

Never:

- Soft-blend mid-flight to hide disagreement  
- Skip hard pose on **self** (another player can knock your ball; hard is whole-hole authority)  
- Rewind/advance sim clock from soft packets  

---

## Soft packets

**Soft = juice only** (SFX, particles, banners).

Never touch: `x/y/vx/vy/z`, strokes (except cosmetic max), float, `mpSimTick`, hole epoch.

---

## Visual catch-up (host path history)

**Every hard** (not only replay) carries per-ball **`path`**.

| After seed@H → resim | Draw |
|----------------------|------|
| **Residual match** | Visual **no-op** (restore prior present). |
| **`!matched`** + path | Sim = host present. **Draw** catch-up: current board → host path (from nearest sample forward) → live (`N = path.length`). Never rewinds to last-hard path[0]. |

Host rules (always the same):

1. Record **posePath** every physics subtick for every ball.  
2. On hard: path = time-even decimation of that ball’s posePath (buffer since previous hard).  
3. After hard: clear posePath (next hard starts a new interval).  

No putter-only logic, min-length checks, or synthetic keyframes. Soft packets: no path.  
Client: residual match → no path play; else path if present.  
Regression: `npm run test:dave-trail-hypotheses`. Observability: `docs/path-trace.md`.

---

## Host responsibilities (unchanged core)

- Shared hole epoch W0 + integer ticks  
- Input log + history ring  
- Legal putt at clientTick T → rewind → apply inputs → physics → **hard full-hole snapshot at hostNow**  
- Discrete water / clash / holed / blackHole → **hard** state (events list for juice)  
- Idle hard is a rare belt when truly idle — should residual-match when healthy  

---

## No self-skip on hard

Hard applies to **all** balls, including local player. Skipping self to protect optimistic putts loses clashes and other players’ interactions with your ball. Residual match after host-resim present is the only visual no-op when free-run already agreed — not “ignore hard pose.”

---

## Remote putts

- `puttApplied` = confirmed **input juice** + launch impulse at putt pose for prediction  
- Free-run is **only** the shared sim loop (`mpUpdateLocalSim` / whole-world steps)  
- **No** single-ball “age T→present against frozen peers” and **no** invented future ticks  
- **State truth** = hard `replay` / hard event via the Law (seed@H → resim)  
- Soft / event lists after hard = **juice only** (SFX); poses already on `balls[]`  

### Regression tests must not reward timing hacks

`test:e2e-clash` draws **unpredictable** lag/jitter per trial (wide ranges, FIFO delay,
multiple seeds). A fix that only works for one fixed batch delay must fail often.

## Discrete water / clash / holed

- Always **hard** full-hole samples with float/dunks on the wire  
- Client adopts via seed@H (including `floating`); event handlers do not re-author poses  


---

## What we are deleting / starving

| Mechanism | Fate |
|-----------|------|
| Soft pose authority mid-flight | Dead (juice only) |
| Soft clock rewind | Dead |
| `ignore_idle_while_moving` as primary | Starve; residual match handles no-op idle |
| Soft err blend as recon | Visual only after soft settle if anything; not mid-flight recon |
| Residual “keep local when disagree” | Forbidden |

---

## Success metrics

1. 1p + lag-proxy: post-putt hard residual ~0 (existing `test:e2e-lag`)  
2. 2p clash: target predicts hit; no phase-through (`test:e2e-clash`)  
3. Full multi log: fewer `isSelf:false` large residuals after remote putts; self FLY→REST only on true discrete host events, applied cleanly  
4. RbDiag: hard snaps while moving rare; when they fire, they are honest corrections not policy thrash  
