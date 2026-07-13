# Pocket Putt Deployment Guide

Mirrors the Chess101 relay deploy layout (`Chess101/render.yaml` + `deploy/DEPLOY.md`).

**This guide covers the authoritative multiplayer Node server only.** No separate
static frontend service for now — `server.js` still serves the game files on the
same origin (handy for smoke tests). When a multi-room relay lands, swap the
start command / Docker image the same way Chess101 did with `Dockerfile.relay`.

---

## Render (recommended)

Render deploys from the `render.yaml` Blueprint at the repo root whenever you
push to the connected GitHub branch.

### Service

| Service | Type | Notes |
|---|---|---|
| `pocket-putt-server` | Web Service (Node) | HTTP + WebSocket on `/ws`; health at `/health` |

On free plan the instance **spins down after ~15 minutes idle** and cold-starts
on the next request (can take 30–60s). Fine for testing; upgrade to a paid
instance when you want always-on multiplayer.

---

### 1. Push this repo to GitHub

The Render Blueprint reads from a GitHub repo. Confirm remote and push:

```bash
cd /path/to/pocket-putt
git remote -v   # should show github.com/.../pocket-putt.git
git add render.yaml deploy/DEPLOY.md server.js game.js
git commit -m "Add Render blueprint and cloud-ready server health check"
git push origin main
```

If the GitHub repo is private, grant Render access when prompted.

---

### 2. Create the Blueprint on Render

1. Log into [render.com](https://render.com).
2. Click **New → Blueprint**.
3. Connect the **pocket-putt** GitHub repository (and branch, usually `main`).
4. Render parses `render.yaml` and previews the `pocket-putt-server` web service.
5. Click **Apply** (or **Create Blueprint**) and wait for the first deploy.

You should land on a service named `pocket-putt-server` with a free URL like:

```
https://pocket-putt-server.onrender.com
```

(Exact subdomain may differ if the name is taken.)

---

### 3. Environment variables

Render dashboard → `pocket-putt-server` → **Environment**

| Variable | Required | Value | Description |
|---|---|---|---|
| `PORT` | **No — do not set** | — | Render injects `PORT` (e.g. `10000`). The server already uses `process.env.PORT \|\| 8977`. Setting a different port breaks health checks. |
| `PUBLIC_URL` | No | e.g. `https://play.yourdomain.com` | Optional. Overrides the lobby join URL. If unset, the server uses Render’s `RENDER_EXTERNAL_URL` automatically. |
| `NODE_VERSION` | No | `20` | Only if you need to pin Node (Render’s default Node is usually fine). |

There are no Chess101-style `RELAY_MAX_ROOMS` / `RELAY_ROOM_TIMEOUT` vars yet —
this process is still one global lobby. When the multi-room relay lands, add
those (or equivalents) here the same way.

---

### 4. Custom domain (optional)

Skip this until you own a domain you want for the game.

1. Render dashboard → `pocket-putt-server` → **Custom Domains** → add e.g. `play.yourdomain.com`.
2. Render shows a CNAME target (e.g. `pocket-putt-server.onrender.com`).
3. At your DNS provider:

   ```
   Type   Host                    Value
   CNAME  play.yourdomain.com     pocket-putt-server.onrender.com
   ```

4. Wait for TLS to show **Certificate issued** (usually a few minutes).
5. Set env var `PUBLIC_URL=https://play.yourdomain.com` so lobby join links match the custom host, then **Manual Deploy → Deploy latest commit** (or restart) so the process picks it up.

Render provisions and renews TLS automatically — no Certbot.

---

### 5. Verify deployment

**Health check**

```bash
curl -sS https://pocket-putt-server.onrender.com/health
# expect: OK
```

**Logs** — Render dashboard → `pocket-putt-server` → **Logs**. On a successful boot:

```
Pocket Putt server running.
Public URL: https://pocket-putt-server.onrender.com
WebSocket:  wss://pocket-putt-server.onrender.com/ws
Health:     https://pocket-putt-server.onrender.com/health
```

**WebSocket smoke test** (optional, needs [`websocat`](https://github.com/vi/websocat)):

```bash
websocat wss://pocket-putt-server.onrender.com/ws
```

If the socket opens, you’re good. (The protocol expects JSON join messages next;
closing the socket is enough for a connectivity check.)

**Browser smoke test**

1. Open `https://pocket-putt-server.onrender.com` (first hit after idle may cold-start).
2. Join the lobby with a name.
3. Open the same URL in a second browser / phone / private window and join again.
4. Host starts the round — both should see shared physics.

WebSocket path is `/ws` on the same host as the page, with `wss://` when the
page is HTTPS (handled in `game.js`).

---

### Updating

Push to the connected branch. Render redeploys automatically.

```bash
git push origin main
```

Watch **Events** / **Logs** on the service page for the new deploy.

---

### Free-plan gotchas

| Issue | What to do |
|---|---|
| First request after idle is slow | Expected cold start. Upgrade plan for always-on. |
| Health check fails on first deploy | Confirm logs show listen on `0.0.0.0` and you did **not** set `PORT` yourself. |
| WebSocket fails in browser | Page must be HTTPS → `wss://`. Hard-refresh after deploy so clients get the updated `game.js`. |
| Join link shows wrong host | Set `PUBLIC_URL` to your custom domain, or rely on auto `RENDER_EXTERNAL_URL`. |

---

## Local vs cloud (quick map)

| | LAN (`node server.js`) | Render |
|---|---|---|
| Port | `8977` (default) | Render’s `PORT` |
| Join URL | `http://hostname.local:8977` + LAN IP | `RENDER_EXTERNAL_URL` or `PUBLIC_URL` |
| WebSocket | `ws://host/ws` | `wss://host/ws` |
| Health | `GET /health` → `OK` | Same (used by Render probes) |

---

## What this is *not* (yet)

- **Not a multi-room relay** like Chess101’s `network/relay.py`. Today one Node
  process = one shared lobby. Fine for friends testing over the internet.
- **No separate static site** (Chess101’s `chess101-spectator`). The Node
  service serves HTML/JS/CSS/audio itself. Add a second Blueprint service later
  if you want CDN-static frontend + WS-only backend.
- **No VPS / Nginx path documented here.** Chess101 has a full VPS section; copy
  that pattern if you leave Render later (proxy `/` and upgrade WebSocket to the
  Node process, health at `/health`).
