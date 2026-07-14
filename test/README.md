# Multiplayer reconcilation / rubber-band harness

Headless tests that drive a real **`GameSession` host** and a pure **`ClientModel`**
(mirror of `game.js` coast recon: puttApplied → local sim → soft/hard corrections).

## Why this exists

Rubber banding is almost always:

1. **Physics fork** — host and client step differently (dt schedule, sticky latch, etc.)
2. **Hard correction while moving** — sparse `snapshot` with `hard:true` snaps pose
3. **Optimistic putt disagreeing with `puttApplied`**
4. **Host-clock extrapolation** — client free-runs past last host sample, then snaps

A better client model reduces (2)–(4). Lockstep coast tests prove (1) is zero.

## Run

```bash
npm test                    # all scenarios
npm run test:lockstep       # pure physics lockstep only
node test/rubberband-harness.js delayed_putt
node test/rubberband-harness.js --json
```

## Scenarios

| Name | What it stress-tests |
|---|---|
| `lockstep_coast` | Host/client physics identity (must stay ~0 error) |
| `ideal` | Zero latency, sparse hard corrections |
| `delayed_putt` | 80ms±20 puttApplied delay + optimistic launch |
| `snapshot_jitter` | Delay + jitter + 15% dropped snapshots |
| `sticky_escape` | Goo Lagoon sticky latch under delay |
| `multi_clash` | Ball-ball hard clash payloads |

## Metrics

| Metric | Meaning |
|---|---|
| `maxSimErr` / `avgSimErr` | Client physics pose vs host ground truth |
| `maxVisErr` / `avgVisErr` | Visual pose (`rx/ry` after soft offset) vs host |
| `hardSnapsWhileMoving` | **Rubber-band signal** — hard snap mid-roll |
| `puttResyncs` | Optimistic putt disagreed with host `puttApplied` |
| `softApplies` | Soft reconcilation path used (currently rare — most snaps are hard) |

## Adding a scenario

Edit `SCENARIOS` in `rubberband-harness.js`:

```js
my_case: {
  name: 'my_case',
  courseIndex: 0,
  holeIndex: 0,
  frames: 240,
  net: { delayMs: 50, jitterMs: 10, dropRate: 0, seed: 1 },
  thresholds: { maxVisErr: 30, hardSnapsWhileMoving: 5 },
  script(ctx) {
    ctx.atFrame(20, () => ctx.putt(ctx.remotePlayer, { x: 90, y: 0 }));
  },
},
```

## Improving the client model

When you change reconcilation in `game.js`, port the pure logic into
`test/clientModel.js` (keep them in sync). Then:

1. `npm run test:lockstep` must stay green (physics)
2. Tighten thresholds on `ideal` / `delayed_putt` as rubber bands drop
3. `snapshot_jitter` `hardSnapsWhileMoving` is the main scoreboard for recon quality
