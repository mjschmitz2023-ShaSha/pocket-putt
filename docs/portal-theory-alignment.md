# Portal gravity — theory alignment log

Living checklist: where Pocket Putt **meets** the portal papers, and intentional **shortfalls**.
Update when the ship model changes.

## Sources

- *A geometric theory of portals* (draft) — material space `Mat`, surface irrelevance,
  Newtonian / enlarged-Newtonian portals, §2.1.3.5 accelerating-mouth bump potential.
- `GRportal_updated…pdf` — Lorentzian half-space glue, moving mouth \(x=l(t)\),
  proper-time shift / CTC regime.

## What we ship

### Meet

| Claim | Implementation |
|--------|----------------|
| Material-space cut–glue for **mass** gravity | BEM single-layer \(\sigma_A,\sigma_B\) + transmission BCs on mouths |
| Free-space 3D Coulomb on the plane | \(\Phi\propto -1/r\), \(g\propto 1/r^2\) (not 2D log Poisson) |
| Accelerating mouth → real Newtonian \(g\) (strict Galilean, **break** SI) | §2.1.3.5 closed form \(\Phi_\xi=-\xi(r)\,\vec a\cdot\vec y\), \(\vec g_\xi\) paper eq. (4) |
| Inertial mismatch **through** the portal | \(\Phi_\xi\) is part of **direct** field; BEM solves transmission on **total** \(\Phi,g\) (not dual-sample) |
| Period of movers | LCM moons + portal-host gates/pendulums; bake frames |
| Host/client lockstep | Deterministic bake + `cache.fingerprint` |
| No gravitational waves | Explicit non-goal (neither paper’s paradox mechanism) |

### Intentional shortfalls

| Shortfall | Why |
|-----------|-----|
| No Lorentzian metric collar / \(C^2\) spacetime glue | GR PDF is geometry construction; we ship Newton on Mat |
| No mouth proper-time \(\Delta\tau\), twin clocks, CTCs | Avoid dual simultaneous worldlines / causality toys on the playfield |
| Quasi-static elliptic field each tick | Not retarded / hyperbolic GR |
| BEM layers may put weak \(g\) outside pure \(R_\mathrm{out}\) | Material-space completion of the embedding-local bump |
| Game rest thresholds / gain may mute tiny \(g_\xi\) | Playability |
| Enlarged-Newtonian “\(a\) is pure gauge” (§1.4.2.5) **not** used | We want the paradox (real extra gravity) |
| Free-portal \(\sigma_B=-\sigma_A\) pairing not used | Nulls flux influence when \(n_B\approx -n_A\); independent \(\sigma_A,\sigma_B\) instead |

## Architecture (ship path)

```text
Φ_direct = Φ_mass(ρ) + Φ_ξ(mouths, a(t), X(t))
g_direct = g_mass + g_ξ                    // conjugacy-preserving closed forms
solve layers so transmission holds for TOTAL Φ, g
g_play   = g_direct + g_layers             // baked to grid
```

- **Not** dual-sample for product accel-through-portal.
- **Not** fake planet mass for \(\vec a\) (wrong exterior asymptotics).
- Dual-sample portal-G modes remain legacy/debug for non-bake holes only.

## Accelerating-mouth field (local)

With \(\vec y=\vec x-\vec X(t)\), \(r=|\vec y|\), smooth \(\xi(r)\):

- \(r\le R_\mathrm{in}\): \(\vec g \approx \vec a\) (comoving “homogeneous gravity”)
- \(r\ge R_\mathrm{out}\): \(\vec g = 0\) (embedding formula)
- shell: non-gaugeable tidal piece \(\propto \xi'\)

Mouth \(\vec a\) from period-wrapped finite differences of aperture centers
(gate/pendulum hosts only; walls contribute 0).

## Tests that lock the story

See `test/portal-gravity-bake.js`:

- \(\vec g_\xi = -\nabla\Phi_\xi\) conjugacy
- Core \(g\approx a\); far field vanishes
- Near moving mouth, material \(g\) aligns with \(\vec a\)
- Static mouth + accelerating partner → nonzero entry \(g\) after BEM
- Mass through-portal still works; fingerprint lockstep

## Branding

Ship model name (for comments / design talk):

> **Material-space Newton with accelerating-mouth shells**  
> (*A Theory of Portals* Newton path + portal BEM)  
> **not** a truncated Lorentzian GR-portal manifold.
