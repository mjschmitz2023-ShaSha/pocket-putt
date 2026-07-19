# Pocket Putt — agent notes

## Multiplayer visual / “trail” reports

**When the user talks about trails, they almost always mean ball history / catch-up motion, not the cosmetic dotted trail.**

- The cosmetic trail is a **bellwether** for whether the ball’s render path is continuous.
- The real product issue is **where the ball is drawn** over time (path catch-up, residual, free-run).
- Do **not** over-index on densify / trailPts cosmetics when debugging “gaps” or lag motion.
- Prefer path-trace (ball pose histories) and residual/path catch-up over inventing intermediate trail points.

## Hard snapshots — never skip self pose

Hard is **whole-hole** authority for every ball id, including local player.

- **Do not** skip applying hard pose to self to protect optimistic putts.
- Another player’s putt/clash can rewrite your ball; skipping self drops that truth.
- Residual match after host-resim present is the only visual no-op when free-run already agreed.

## Hard-coded magic numbers

Avoid inventing px/frame thresholds for catch-up. Prefer:

- Host wire sample count (path length) for catch-up frame budget
- Shared physics constants (`BALL_RADIUS`, `STOP_THRESHOLD`) for residual “already matches” bands
