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
- Ignore hard because “we’re moving” except pure **causality** (see below)  
- Rewind/advance sim clock from soft packets  

---

## Soft packets

**Soft = juice only** (SFX, particles, banners).

Never touch: `x/y/vx/vy/z`, strokes (except cosmetic max), float, `mpSimTick`, hole epoch.

---

## Host responsibilities (unchanged core)

- Shared hole epoch W0 + integer ticks  
- Input log + history ring  
- Legal putt at clientTick T → rewind → apply inputs → physics → **hard full-hole snapshot at hostNow**  
- Discrete water / clash / holed / blackHole → **hard** state (events list for juice)  
- Idle hard is a rare belt when truly idle — should residual-match when healthy  

---

## Causality exception (narrow)

Only skip applying hard **self** state when hard has **no** `rejectReason` and any of:

1. `sampleTick < lastOptimisticPuttTick` (strictly before our unconfirmed putt)  
2. `reason === 'idle'` and `sampleTick <= lastOptimisticPuttTick` (end-of-tick idle is pre-putt; putt applies on restore(T) — same-tick first-tee race)  
3. `reason === 'idle'` and host self `strokes` **&lt;** local self strokes (host has not counted our shot yet; putt still in flight)

That packet cannot include our shot. Remotes on the packet may still update.  
Reject / resync always apply (undo bad optimism).

**Host still sends hard idle** after sustained rest (tee or post-shot) — it is the belt for
real rest desync and should residual-match when healthy. Do **not** silence tee idle to
hide putt races; client causality handles pre-putt idle. A true idle snap while both sides
are at rest is a desync bug to fix, not a reason to drop idle.

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
