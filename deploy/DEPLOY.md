# Pocket Putt Deployment Guide

Mirrors Chess101’s relay deploy layout (`render.yaml` + this guide).

## What runs on Render

**One service** (`npm start` → `relay.js`):

| Path | Role |
|---|---|
| `GET /` | Game UI (HTML/JS/CSS/audio) — players open this in a browser |
| `GET /health` | Health check (`OK`) |
| `WS /ws` | Multi-room multiplayer (create/join by room code) |

No separate static site. Friends only need the public URL — they do **not** download the repo.

```
https://pocket-putt-server.onrender.com/
```

1. Open the URL  
2. **Create Room** → share the link (`/?room=ABCDEF`) or the code  
3. Friend opens the link (or joins with the code)  
4. Host starts the round  

---

## Architecture

```
Browser A  ──HTTPS+WSS──┐
Browser B  ──HTTPS+WSS──┼──►  relay.js (Render)
Browser C  ──HTTPS+WSS──┘       ├── static game files
                                └── rooms[code] → GameSession (authority)
```

Handshake (first WebSocket message), Chess101-style:

| Client → relay | Meaning |
|---|---|
| `relay_create` `{ player_name }` | Create a room (you become host) |
| `relay_join` `{ room_code, player_name }` | Join existing room |
| `relay_reconnect` `{ room_code, token }` | Resume after refresh |

Then normal game messages: `startRound`, `putt`, etc.

Each room runs authoritative physics on the server (unlike Chess101’s pure peer-forward), so putts/scoring stay consistent.

---

## Render

### Deploy / update

Production deploys from **`main`**:

```bash
git push origin main
```

In the Render dashboard, set the service **branch = `main`**, start command **`npm start`**.

### Environment

| Variable | Required | Suggested | Description |
|---|---|---|---|
| `PORT` | **Do not set** | — | Render injects this |
| `RELAY_MAX_ROOMS` | No | `200` | Max concurrent rooms |
| `RELAY_ROOM_TIMEOUT` | No | `900` | Idle seconds before room deleted |
| `RELAY_MAX_PLAYERS` | No | `8` | Max players per room |
| `PUBLIC_URL` | No | custom domain | Optional; else uses `RENDER_EXTERNAL_URL` for share links |

### Verify

```bash
curl -sS https://pocket-putt-server.onrender.com/health
# OK

curl -sS -o /dev/null -w "%{http_code}\n" https://pocket-putt-server.onrender.com/
# 200  (game HTML)
```

Open the URL in two browsers → Create Room / Join → Start Round.

Free tier: first hit after idle can take 30–60s (spin-up).

---

## Local

```bash
npm start          # same process as production
# open http://localhost:8977/
```

`npm run lan` is an alias for the same multi-room server.  
`npm run lan-legacy` runs the old single-lobby `server.js` if you ever need it.

---

## Custom domain (optional)

Service → Custom Domains → CNAME. Share links use that host once TLS is ready.
