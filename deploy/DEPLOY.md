# Pocket Putt Deployment Guide

Mirrors Chess101’s relay deploy (`Chess101/render.yaml` + `deploy/DEPLOY.md`).

## What runs on Render

| Process | Command | Role |
|---|---|---|
| **`relay.js`** | `npm start` | Multi-room WebSocket relay — **no game UI** |
| `server.js` | `npm run lan` | Local LAN host **with** static frontend (not deployed) |

The cloud service only speaks:

- `GET /health` → `OK`
- `WS /ws` → room handshake + game protocol

Visiting `https://….onrender.com/` in a browser returns a short plain-text notice, **not** the putt game. Clients load the game from a LAN host or any static host, then open:

```
http://localhost:8977/?online=1
# or
http://localhost:8977/?relay=wss://pocket-putt-server.onrender.com/ws
```

---

## Architecture (like Chess101)

```
Browser A  ──wss──┐
Browser B  ──wss──┼──►  relay.js (Render)  ── per-room GameSession (authority)
Browser C  ──wss──┘         rooms keyed by 6-char codes
```

Handshake (first WebSocket message), Chess101-style:

| Client → relay | Meaning |
|---|---|
| `relay_create` `{ player_name }` | Host creates a room |
| `relay_join` `{ room_code, player_name }` | Join existing room |
| `relay_reconnect` `{ room_code, token }` | Resume after refresh |

Responses: `relay_created` / `relay_reconnected` / `relay_error`, then game `welcome` + `lobbyState`.

Unlike Chess101’s pure peer-forward relay, each Pocket Putt room runs **authoritative physics** on the relay (putts, scoring, multi-ball). That matches today’s client protocol.

---

## Render (recommended)

### 1. Push the `relay` branch

```bash
git push origin relay
```

### 2. Blueprint / service

Service **`pocket-putt-server`** should already exist if you applied the Blueprint earlier.

After pushing multi-room relay code:

1. Confirm **branch = `relay`**
2. **Manual Deploy → Deploy latest commit**
3. Ensure **start command** is `npm start` (runs `node relay.js`)

### 3. Environment variables

Dashboard → **Environment**

| Variable | Required | Suggested | Description |
|---|---|---|---|
| `PORT` | **Do not set** | — | Render injects this |
| `RELAY_MAX_ROOMS` | No | `200` | Max concurrent rooms |
| `RELAY_ROOM_TIMEOUT` | No | `900` | Idle seconds before room deleted |
| `RELAY_MAX_PLAYERS` | No | `8` | Max players per room |

### 4. Verify (no game UI)

```bash
curl -sS https://pocket-putt-server.onrender.com/health
# OK

curl -sS https://pocket-putt-server.onrender.com/
# plain text: "Pocket Putt relay (WebSocket only)…"
```

Logs should say:

```text
Pocket Putt multi-room relay
Listening  0.0.0.0:…
No static frontend — clients use relay_create / relay_join
```

### 5. Play against the cloud relay

On a machine with the game files (LAN host or any static server):

```bash
npm run lan
# open http://localhost:8977/?online=1
```

1. **Create Room** → share the 6-letter code  
2. Friend opens same URL with `?online=1` → **Join Room** + code  
3. Host **Start Round**

Cold start on free plan can take 30–60s on first WebSocket connect.

---

## Local multi-room relay (dev)

```bash
# terminal 1 — relay (no UI)
npm run relay

# terminal 2 — game files only (or any static server)
npm run lan
# open http://localhost:8977/?relay=ws://127.0.0.1:8978/ws
```

If LAN host and relay both default to 8977, run relay on another port:

```bash
PORT=8978 npm run relay
# ?relay=ws://127.0.0.1:8978/ws
```

---

## Custom domain (optional)

Same as before: Custom Domains → CNAME → set clients’ `?relay=wss://your.domain/ws`.

---

## Free-plan gotchas

| Issue | What to do |
|---|---|
| First connect after idle is slow | Free spin-down; upgrade for always-on |
| Browser shows plain text at onrender.com | **Expected** — not a bug |
| Health fails | Don’t set `PORT`; start must be `npm start` → `relay.js` |
