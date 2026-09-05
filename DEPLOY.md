# Axewatch — 24/7 Deployment Guide

## Architecture

```
[nginx :80] ── serves frontend + proxies /api ──> [FastAPI backend:8000]
                                                        │
                                          SQLite volume (all snapshots/history)
```

Only port 80 is public. The backend is never exposed directly.

## Option A — Indian VPS

1. Get a VPS with an **Indian IP** (E2E Networks, Hostinger India, DigitalOcean BLR, ~₹300–500/mo).

2. Test NSE access BEFORE anything else:

```bash
curl -A "Mozilla/5.0" "https://www.nseindia.com/api/marketStatus"
```

If you see JSON → good. If HTML/403 → that IP range is blocked, ask the provider to
reassign your VM's IP or pick another provider.

3. Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

4. Upload the project and start:

```bash
cd Axewatch
docker compose up -d --build
docker compose logs -f backend     # watch first data come in
```

Site is live at `http://<vps-ip>/`.

## Option B — Home PC / Raspberry Pi + your own domain (free, recommended)

Your stack stays exactly as-is (best NSE access, SQLite persists). Cloudflare
Tunnel publishes it on your domain with free HTTPS — no port forwarding, works
behind CGNAT, nothing listens publicly.

**One-time setup (~20 min):**

1. **Point your domain at Cloudflare** (free plan): add the site at
   dash.cloudflare.com → change nameservers at your registrar → wait for the
   active checkmark.
2. **Create the tunnel:** Zero Trust (`one.dash.cloudflare.com`) → Networks →
   Tunnels → Create → copy the **token**. Add a **Public Hostname**, e.g.
   `axewatch` + your domain, Service Type `HTTP`, URL `http://frontend:80`.
   (Cloudflare creates the DNS record for you.)
3. **Start it** from the repo root (PowerShell):
   ```powershell
   $env:CLOUDFLARE_TUNNEL_TOKEN = "<paste-token>"
   docker compose --profile tunnel up -d
   ```
   To persist across reboots, put `CLOUDFLARE_TUNNEL_TOKEN=<token>` in a `.env`
   file next to `docker-compose.yml` (same place `AXEWATCH_PORT` goes) instead
   of the `$env:` line. Dashboard should show the tunnel **Healthy**.
4. **Lock it down — do not skip.** Axewatch has no login and holds PANs:
   Zero Trust → Access → Applications → Add self-hosted app for your hostname →
   Allow policy for just your/family emails (one-time PIN or Google login).
   Free for up to 50 users. Test in an incognito window: you should hit a
   Cloudflare login before the site.
5. Open `https://axewatch.<yourdomain>` — live SSE, auto-refresh, everything
   works (named tunnels fully support Server-Sent Events).

**Day-to-day:** `docker compose up -d` still starts only backend+frontend (the
tunnel stays as you left it). `docker compose logs -f axewatch-tunnel` to check
the tunnel. Keep Docker Desktop launching at Windows startup so it survives
reboots; `restart: unless-stopped` handles the rest.

## Updating CORS for your domain

When you have a real domain (e.g. `https://axewatch.example.com`), set it in a `.env`
file next to `docker-compose.yml`:

```
AXEWATCH_ORIGINS=https://axewatch.example.com,http://localhost:5173
```

Then `docker compose up -d` again.

## HTTPS

Quickest path: put the site behind Cloudflare (orange cloud) — free SSL, hides server IP.
Or run Caddy instead of nginx (`caddy` auto-provisions Let's Encrypt certs).

## Maintenance

```bash
docker compose logs -f backend      # logs
docker compose restart              # restart after config change
docker compose up -d --build        # rebuild after code change
ls -lh backend/axewatch.db          # DB lives in named volume; survives rebuilds
sqlite3 backup:
docker exec axewatch-backend sh -c "apt-get update >/dev/null && apt-get install -y sqlite3 >/dev/null; sqlite3 /data/axewatch.db '.backup /data/backup.db'"
```

## Rate-limit safety notes

- Backend fetches NSE every 3 min (~20 req/hour) and GMP every 30 min — far under limits.
- All user traffic hits your cached snapshots; NSE never sees your visitors.
- If you add more endpoints, keep total requests under ~10/min per IP.
