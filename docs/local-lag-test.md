# Local lag testbed (bidirectional proxy)

## Principle

Physics is deterministic. In a **1-player multiplayer** game, host and client run the same laws. If the ball still rubber-bands under lag, the bug is **netcode timeline** (putt applied at receive time, not input tick) — not multiplayer chaos.

**Agreed fix (design only):** tick-stamped putts + whole-hole rewind/replay — see `docs/mp-tick-stamped-inputs.md`.

**Lag must be bidirectional.** Real RTT delays:

- browser → server (putts, handshakes)
- server → browser (puttApplied, snapshots)

One-way client delay is asymmetric and not a valid test of production path.

## Architecture

```
  browser ──WS msgs──► lag-proxy ──WS msgs──► relay (GameSession authority)
  browser ◄──WS msgs── lag-proxy ◄──WS msgs── relay

  HTTP static assets reverse-proxied with no extra delay.
  Each WS message: delay = LAG_MS ± JITTER_MS (independent per direction).
```

## Live browser

Terminal A — real authority (no lag):

```bash
npm start
# :8977
```

Terminal B — bidirectional lag proxy:

```bash
npm run lag-proxy
# LAG_MS=80 JITTER_MS=40 by default → ~160ms RTT ± jitter
# :8978
```

Open **through the proxy** (not :8977):

```
http://localhost:8978/?rbdebug=1
```

1. Create room, start as **only player**
2. Putt; watch console for `[RB] hard_snap_while_moving`
3. Dump: `RbDiag.summary()` in the console

Zero-lag control (bypass proxy):

```
http://localhost:8977/?rbdebug=1
```

Joiner with same RTT: also use `:8978/?room=CODE&rbdebug=1`

Heavy lag:

```bash
npm run lag-proxy:heavy
```

## Console detector (`?rbdebug=1`)

Observe-only — does **not** change physics.

| Log | Meaning |
|-----|---------|
| `[RB] hard_snap_while_moving` | Hard authority rewrote pose while ball was moving (**rubber band signal**) |
| `[RB] hard_snap` | Hard apply with larger settle gap |
| `[RB] putt_resync` | Self puttApplied re-applied pose after already coasting |
| `RbDiag.summary()` | Counters + recent events |

## Headless first-principles scenarios

```bash
npm run test:solo-lag
# solo_1p_ideal              — 1p, 0 lag
# solo_1p_bidirectional_lag  — 1p, 80±40 each way (putt↑ + snapshot↓)
```

Expect: `hardSnapsWhileMoving === 0` and `puttResyncs === 0` if coast netcode is correct for a lone deterministic player.
