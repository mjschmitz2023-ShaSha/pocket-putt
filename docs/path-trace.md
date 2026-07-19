# Path Trace (multiplayer observability)

Human + machine harness for the mid-shot path gap. Records **three complete ball histories** and lets you step them together.

| Lane | Source |
|------|--------|
| **Host dense** | Every physics subtick on `GameSession` (`pathTrace.host`) |
| **Putter client** | That browser’s sim + render samples (`?pathtrace=1`) |
| **Observer client** | Other browser’s sim + render samples for the same ball |

Also records **wire path** events (sparse N keyframes on hard replay) so you can compare host dense vs what left the wire vs what each client drew.

## Run

```bash
npm start
# optional lag:
npm run lag-proxy
```

## Capture a putt

1. **Putter** (host or guest):  
   `http://localhost:8977/?pathtrace=1`  
   (or via lag-proxy `:8978`)

2. **Observer**: same origin with `?pathtrace=1&room=CODE` and a trail cosmetic if you care about trail drawing.

3. Start the round, **make a putt**.

4. On **each** client, use the bottom-right **PathTrace** panel:
   - **Push dump** — sends this client’s samples to the host room store
   - Or **Viewer** — requests the full bundle and opens the stepper

5. Open the viewer:

```
http://localhost:8977/path-trace.html?room=CODE
```

Click **Fetch room dump**. You should see host samples immediately; client lanes only after each side pushed.

## Viewer controls

- **← / →** step one sample (Shift = ×10)
- **Home / End** first / last
- Click the plot to jump to nearest host sample
- Side panel: putter↔host, observer↔host distances, neighbor gaps, events near tick
- **Wire path** = red keyframes (what the hard correction carried)

## Save / share

- Client panel **Save local** → single-client JSON  
- Viewer **Export bundle** → host + all pushed clients  
- `GET /path-trace/CODE` → same JSON as Fetch (no auth; local debug only)

## What to look for

| Symptom in stepper | Likely meaning |
|--------------------|----------------|
| Host dense neighbor gap huge mid-stroke | Host sample stream itself uneven / missing segment |
| Host continuous, wire jumps | Decimation / wrong dense window on wire |
| Host+wire OK, observer jumps | Client residual / path catch-up / free-run |
| Putter matches host, observer doesn’t | Observer hard/path path only (not putter optimism) |
| `replay_boundary` phase samples | Extra host samples at tick boundaries (not subticks) |

## Console

With `?pathtrace=1`:

```js
PathTrace.localDump()
PathTrace.pushToServer()
```

Host always records while the hole is live (capped ~4000 samples/ball). Cleared on each `beginHole`.
