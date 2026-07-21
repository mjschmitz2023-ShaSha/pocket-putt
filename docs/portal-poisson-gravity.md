# Material-space portal gravity (BEM)

## When

Bake if the hole has **≥1 portal pair** and (**≥1 gravity body** OR a **moving
portal host** gate/pendulum). Static portals with no mass and no movers → no bake
(Orbit free-space only).

## Physics

```
Φ = Φ_direct + Φ_layers
Φ_direct = Φ_mass + Φ_ξ
Φ_mass   = Σ −G m / r          →  g_mass = Σ G m (x_m − x) / r³
Φ_ξ      = −ξ(r) a·(x−X)       →  g_ξ = ξ a + ξ'(a·y) û   (§2.1.3.5)
```

`Φ_ξ` is the Theory of Portals accelerating-mouth shell (compact bump around each
mouth with lab-frame acceleration `a`). It is **direct** potential, not fake mass.
BEM layers solve transmission on the **total** direct field so inertial mismatch
propagates through the portal the same way mass wells do (no dual-sample product path).

Layers: **independent** single-layer densities σ_A, σ_B on each portal mouth
(Nyström, 32 panels). Free-portal pairing σ_B=−σ_A is **not** used: with outward
normals n_B≈−n_A it makes flux influence identically zero, so flux BCs cannot be
enforced and the dense system goes rank-deficient.

Transmission collocation on enterable faces (offset along outward normal):

```
Φ(A_ε) = Φ(B_ε)
g·n_A(A_ε) + g·n_B(B_ε) = 0
```

2M unknowns (σ_A, σ_B) × 2M equations per pair — real dense solve (not FDM edge rewiring).

Theory meet/shortfall log: [`portal-theory-alignment.md`](./portal-theory-alignment.md).

### Regularization (C¹ Plummer)

Self-terms use Plummer `R = √(r²+ε²)` with `ε = max(0.12, 0.08 · panelLen)` so **soft ≪ panel**.
Single-layer `g` is exactly `−∇Φ` for that kernel (no hard soft-floor that breaks conjugacy).
Double-layer uses the analytic `−∇(∂n 1/R)`.

Planet **crust/interior** policy is intentionally free-space only: solid collisions already
keep the ball outside planet radii, so we do not re-apply interior gravity rewrites on top of BEM.

### Solver

Dense Gaussian elimination with relative ridge (`1e-8 · mean|diag|`). Rank-deficient
columns are pinned to 0 (no silent NaN from skipped pivots).

## Period

LCM of:

- moon `orbitPeriodTicks`
- portal-host gate/pendulum `round(periodSeconds * 60)`

Windmills ignored. Cap **2400 ticks (40s)** — covers Double Slit LCM **1584**.
If raw LCM exceeds cap, bake is truncated (`cache.capped`, `cache.rawLcm`); prefer snapping designer periods.
Host and clients use the same `min(LCM, cap)` so fields stay lockstep.

## Host / client lockstep

Both sides bake from the same hole pose with deterministic BEM (`cache.fingerprint` logs
identity). Host: `gameSession.ensurePortalGravityBake`. Client: `ensurePortalGravityBake`
awaited before aim. Lobby re-decode reattaches via `portalGravityBakeStore`.

### Multiplayer start barrier

When a hole needs a portal bake, host enters **`GRAVITY_LOADING`** (sim does not advance),
broadcasts `roundState` with `gravityBakePending: true`. Each client bakes then sends
`gravityBakeReady`. Host starts **`PLAYING`** only after every connected client has acked
(re-stamps hole epoch so free-run clocks match). 60s timeout starts with whoever is ready.
Disconnects drop out of the barrier set.

## Loading

Solo `loadHole` and MP `mpBeginHole` **await** bake with `#gravity-loading` bar.
`Game.state === 'LOADING'` / `Game.gravityBaking` freezes the sim until ready.
No artificial minimum delay.

## Visualization

```
?gravvis=1
?gfield=1
localStorage.ppGravVis = '1'
```

Draws log|g| heatmap + sparse g arrows with triangular tips (`Draw.drawGravityPotentialOverlay`).
**Editor Test mode always enables the overlay** (`force: true`) after the BEM bake finishes.
In the live game, use the URL/localStorage flags above.
Percentile color scale on log|g| so planet cores do not crush contrast.

## Files

- `portal-gravity.js` — BEM bake + sample
- `shared.js` `gravityAccelAt` — uses `hole._portalGravityCache` when present
- `game.js` — loading gate (solo + MP), overlay, bake store
- `gameSession.js` — host bake for authoritative physics
