# Tick-stamped inputs & whole-hole rewind (Pocket Putt MP)

| Field | Value |
|-------|--------|
| **Status** | Implemented (2026-07-18) — host whole-hole ring + input log + rewind/replay; clientTick putts; keepalives; hard replay/resync adopt |
| **Date** | 2026-07-18 |
| **Related** | `docs/local-lag-test.md`, rubber-band harness, `lag-proxy.js` |
| **Problem evidence** | 1-player under bidirectional lag still gets hard idle snaps with `dPos ≈ 2px` when putts carry no client tick |

---

## 1. Problem

Physics is **deterministic**. In a **1-player** multiplayer session, client and host run the same laws. If they still disagree after a putt, the bug is **timeline**, not multiplayer chaos.

**Today:**

```js
// Client
{ type: 'putt', dragVector }

// Host applies at arrival
tick: this.simTick  // receive time, not input time
```

Under lag (bidirectional proxy: ~RTT 160ms ± jitter):

1. Client optimistically putts at local tick **T**
2. Host receives later and applies at host tick **H ≠ T**
3. Both coast from the same rest pose + launch **but on different absolute ticks** (obstacle phases, step counts diverge)
4. On `becameIdle`, host sends **hard idle**; client is ~2px off → rubber-band / settle snap

**Philosophical requirement:** same rest state + same input + **same sim tick for that input** + same stepper ⇒ identical path. Hard snaps of any size mean those four were not shared.

---

## 2. Goals

1. Client stamps putts with sim tick **T**; host validates and applies as of **T** via **whole-hole rewind & replay**.
2. Concurrent / out-of-order late inputs are handled via an **append-only input log** (no corner-cutting).
3. Trust window sized by **RTT**; **keepalives** grant/revoke trust; untrusted clocks **force-sync**.
4. Optimistic launch stays (feel); reject = silent force-sync (no special UI).
5. Hard idle **kept as safety net** (should become no-op when healthy).
6. Prove with 1p + `lag-proxy` + `?rbdebug=1`: idle hard `dPos ≈ 0`.

## 3. Non-goals

- Soft-blend “fake smooth” that hides sim disagreement
- One-way client lag as a realism test (use `lag-proxy.js`)
- Full lockstep every frame / continuous pose stream
- Removing host authority over *legality* of putts (rest, strokes, floating, etc.)

---

## 4. Shared clock

### 4.1 Hole epoch

For each hole:

- Sim tick always starts at **`T0 = 0`**
- Host announces wall time **`W0`** when that hole’s tick 0 begins

```text
idealTick(wallTime) ≈ floor( (wallTime - W0) / TICK_MS )
```

**Tick is the physics contract.** Wall time is for RTT, keepalives, and diagnostics—not for stepping friction by itself.

### 4.2 Initial / join sync (host → client, reliable)

On hole begin and on mid-hole join:

```js
{
  type: 'clockSync',           // or fields on roundState
  holeIndex,
  tick: 0,                     // or current host simTick if mid-hole
  hostTimeMs: <Date.now()>,  // W0 at hole start; or "now" + tick for join
  tickHz: 60,
  // At hole start: tick === 0 and hostTimeMs is W0
}
```

Client:

1. Adopts host `tick` and obstacle clock for that tick  
2. Stores epoch (`W0` / mapping) for keepalive/RTT math  
3. Clears optimistic junk on hole boundaries  

### 4.3 Client advance between host samples

**Capped prediction (not pure wall free-run):**

- Let `H` = last known authoritative host tick (snapshot / clockSync / post-replay)
- Client may advance local sim only up to roughly **`H + N`**, where `N` is the trust window  
- Keepalives report the client’s actual `mpSimTick`, wall time, and `lastHostTick`

---

## 5. Trust window & keepalives

### 5.1 Window size (model D)

| Signal | Role |
|--------|------|
| **RTT** | Sizes `N` (how late a real putt may look) |
| **Keepalives** | Whether this client’s clock is still trusted |
| **Force-sync** | Trust lost → client must adopt host timeline + state |

Starting history / max fixable lag: **~30 ticks (~500ms)** fixed (tune later; may become RTT-adaptive with clamp).

Rough healthy window: convert RTT → ticks + small jitter pad, clamp to history depth.

### 5.2 Keepalive (client → host)

Semi-regular (e.g. every **250–500ms**), not every frame:

```js
{
  type: 'clientClock',
  tick: mpSimTick,
  clientTimeMs: Date.now(),
  lastHostTick: <last adopted host tick>,
}
```

Host tracks per player:

- `lastKeepaliveTick`
- `lastKeepaliveWall`
- Estimated RTT / skew  
- Trust flag  

**Miss 2–3 keepalives** (or frozen tab pattern) → untrusted → force-sync that client.

### 5.3 Monotonic floor

Reject any client gameplay message whose `tick < lastKeepaliveTick` for that player  
(client already advertised “I’m at least at K”).

**Note:** packet reorder under jitter may false-reject; if seen in dogfood, add small grace or sequence numbers. Default rule stands.

### 5.4 Putt acceptance

Client putt:

```js
{
  type: 'putt',
  dragVector: { x, y },
  clientTick: T,   // mpSimTick at release (input time)
}
```

Host accepts only if:

1. Player trusted (keepalives healthy)  
2. `T` within `[hostNow - N, hostNow]` (and not in the future past host now beyond tiny skew)  
3. `T >= lastKeepaliveTick`  
4. Normal gameplay rules: PLAYING, ball present, may putt (rest/quasi-rest), not floating, etc.  
5. `T` still inside snapshot history ring  

Otherwise → **reject + force-sync** (no special UI).

---

## 6. Optimistic putt & reject

### 6.1 Normal path (accept)

1. Client: on release, **launch immediately** (optimistic), send putt with `clientTick`  
2. Host: validate; if OK → insert input log → **whole-hole rewind & replay** from `T` → live  
3. Host → all clients: **hard full-hole snapshot** at current host tick after replay  
4. Putting client: **always hard-adopt** that snapshot (sim + render authority)  
5. Client continues to apply later host updates as today  

### 6.2 Reject path

Host never applied the shot (or cannot legally). Client already launched.

**Force-sync = full host hard resync** (same family as resync snapshot):

- Board / balls / strokes / floats / wet / boosts as on host  
- Sim tick + obstacle clock to host  
- Animated elements from tick  
- **Undo putt** is automatic: host strokes/state are pre-putt  

**No banner/modal** for reject—just resync.

---

## 7. Whole-hole rewind & replay (host)

### 7.1 State

Host maintains for the last **~30 ticks**:

1. **Ring buffer of whole-hole snapshots**  
   All players’ balls and relevant player fields (strokes, floating, dunks, speed trackers as needed), hole-scoped flags, pending event buffers if any.  
   Obstacles: prefer **recompute** via `setHoleObstaclesAtTick(hole, t)` after restore rather than storing every angle if the formula is absolute.

2. **Append-only input log**  
   `{ tick, playerId, kind: 'putt', dragVector, ... }` (and future input kinds).

### 7.2 On legal late putt at `T`

1. Insert into input log  
2. Let `T* = min tick affected` (this putt; if multiple pending, earliest)  
3. Restore whole-hole snapshot at **start of tick `T*`** (or end of `T*-1`—pick one convention and keep it)  
4. Replay ticks `T* .. H` (host now):  
   - **Input phase:** apply *all* inputs for this tick (see simultaneous putts)  
   - **Physics phase:** existing `stepSimulation` body for one tick (subticks, floats, clashes, water, …)  
5. Broadcast **hard full-hole snapshot** at `H`  
6. Optionally still emit `puttApplied` for juice/debug; **state truth is the hard snapshot**

### 7.3 Simultaneous same-tick putts

For a given tick `T`:

1. Apply **all** putts stamped `T` (set launch velocities on each ball)  
2. Run **one** physics step for `T`  

No putt→physics→putt interleaving inside a tick. Order of applying impulses to **different** resting balls is irrelevant. Two putts same player same tick: illegal → keep last or reject.

### 7.4 Nested / concurrent late inputs

If another late input arrives during or after a replay:

- Insert into log  
- Schedule replay from `min(previous T*, new T)`  
- Coalesce: don’t deeply nest; “pending replay from tick X” flag, single-threaded host  

There is no correct shortcut that skips this if multiple delayed inputs can rewrite history.

### 7.5 Host does not permanently live at client time

Host sim advances as today for real-time play. Rewind is **transient** for correcting the authoritative past inside the history window.

---

## 8. Hard idle (safety net)

**Keep** today’s became-idle **hard** snapshot behavior.

| When fix works | Hard idle is ~no-op (`dPos ≈ 0`) |
|----------------|----------------------------------|
| Residual bug / miss | Hard idle corrects; snap size = remaining error |

Idle hard is **not** the lag fix; it is the **belt**. Primary fix is tick-stamped putt + rewind/replay + post-replay hard snapshot.

Success metric: under 1p + lag-proxy, RbDiag idle hard shows **`dPos ≈ 0`** (not ~2px).

---

## 9. Client responsibilities (summary)

| Event | Action |
|-------|--------|
| `clockSync` / hole start | Adopt tick, `W0`, clear optimistics |
| Putt release | Optimistic launch + send `{ putt, clientTick }` |
| Keepalive timer | Send `clientClock` |
| Hard full-hole snapshot (post-replay / resync / reject) | **Hard-adopt** all authority state + tick |
| Soft snapshots | Existing soft rules mid-coast (unchanged in spirit) |
| Hard idle | Adopt (safety net; should match) |

---

## 10. Host responsibilities (summary)

| Event | Action |
|-------|--------|
| Hole start | `simTick = 0`, set `W0`, snapshot ring seed, clear input log for hole |
| Each tick | Step sim; push whole-hole snapshot into ring; drop entries older than ~30 ticks |
| `clientClock` | Update trust / RTT / `lastKeepaliveTick` |
| `putt` + `clientTick` | Validate window & rules → log + rewind/replay + hard snapshot, or reject + force-sync |
| becameIdle | Hard idle snapshot (safety net) |

---

## 11. Test plan

### Live

```bash
npm start          # :8977 authority
npm run lag-proxy  # :8978 bidirectional 80±40 each way
# open http://localhost:8978/?rbdebug=1
# 1 player only — putt, then RbDiag.summary()
```

**Pass:** no systematic `hard_snap_while_moving`; idle hard `dPos` ~ 0.

### Headless

Extend rubberband harness:

- `solo_1p_bidirectional_lag` with tick-stamped putts + host rewind model (when implemented)  
- Gate: `hardSnapsWhileMoving === 0`, max residual at idle below epsilon  

### Regression

- 2p same-tick putts (simultaneous impulses then physics)  
- Two late putts different ticks (ordered replay)  
- Reject path: optimistic undo via full resync  
- Keepalive starvation → force-sync  

---

## 12. PR-shaped implementation order (when building)

1. **Wire + clockSync + keepalives + trust window** (no rewind yet) — measure only  
2. **Host snapshot ring + input log + whole-hole rewind/replay** for putt  
3. **Post-replay hard full-hole snapshot**; client hard-adopt  
4. **Reject + force-sync** path  
5. **Tune N / keepalive**; harness + live 1p proof  
6. Multiplayer stress (dual late putts, clash during replay window)  

---

## 13. Open implementation details (non-blocking)

Resolved in spirit; exact code can choose and document:

- Snapshot = deep clone vs structural copy of ball fields  
- Restore at “start of T” vs “end of T−1”  
- Whether `puttApplied` remains for SFX alongside hard snapshot  
- Exact RTT estimator from keepalive timestamps  
- Reorder grace on monotonic floor if false rejects appear  

---

## 14. One-line summary

**Stamp putts with client sim tick; host keeps a short whole-hole history and an input log; late legal inputs rewind the hole and replay all inputs in tick order (same-tick putts simultaneous); tell everyone with a hard snapshot; keepalives + RTT define trust; reject is silent force-sync; hard idle stays as a safety net that should go quiet when the fix works.**
