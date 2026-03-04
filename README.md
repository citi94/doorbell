# Eufy E340 Doorbell → HomeKit Bridge

## Overview

Eufy Video Doorbell E340 (T8214) paired with HomeBase S380 (T8030), bridged directly to Apple HomeKit via a custom Node.js app running on a lightweight Alpine Linux VM.

Previously ran on Home Assistant OS, but the HAOS VM (4GB RAM, 5 Docker containers) crashed every 8-27 hours due to an HVF bug. Replaced with a minimal setup: single Node.js process using eufy-security-client + HAP-nodejs.

## Network

| Device | IP | Notes |
|---|---|---|
| Mac Mini (host) | `<host-ip>` | Intel i5-8500B, 32GB RAM, macOS 15.7.4 |
| Pi-hole VM | `<pihole-ip>` | QEMU, Ubuntu, 384MB RAM, 1 vCPU |
| Doorbell VM | `<vm-ip>` | QEMU, Alpine Linux, 512MB RAM, 1 vCPU |
| HomeBase S380 | `<homebase-ip>` | T8030, connected via Ethernet |
| Gateway | `<gateway-ip>` | |

## Architecture

```
Eufy E340 Doorbell
       | (private WiFi Direct)
       v
HomeBase S380
       | (P2P over LAN + Eufy Cloud push notifications)
       v
eufy-security-client (Node.js, in-process)
       |
       ├──→ HAP-nodejs DoorbellController
       |         |
       |         ├──→ ringDoorbell() → HomePods chime
       |         ├──→ MotionDetected → HomeKit alerts
       |         └──→ Video stream request → ffmpeg → SRTP → Apple Home
       |
       ├──→ Audio stream request → ffmpeg-hk (libfdk_aac AAC-ELD) → SRTP → Apple Home
       ├──→ Return audio (talkback) → ffmpeg-hk SRTP receive → AAC-LC → eufy TalkbackStream
       ├──→ Snapshot: periodic P2P grab (60s) / event image cache / livestream frame capture
       ├──→ Event logging → SQLite (/opt/doorbell/events.db)
       └──→ HTTP dashboard (port 80) with API + web UI
```

## What Works

- Doorbell ring → HomePods play chime sound (VIDEO_DOORBELL category)
- Motion / person / pet / stranger / face detection events in HomeKit
- Live video + audio streaming via P2P → ffmpeg → SRTP to Apple Home
- Two-way audio (talkback) — speak through Apple Home to the doorbell speaker
- Real camera snapshots for HomeKit thumbnails and rich notifications
- Push notifications via Eufy cloud
- Event logging to SQLite database
- Web dashboard with activity charts, daily summaries, search, and CSV/JSON export
- Auto-reconnect with exponential backoff (10s→60s cap)
- Remote management via Tailscale SSH

## What Doesn't Work

- HomeKit Secure Video recording

## Snapshots

HomeKit thumbnails use real camera images with a smart refresh strategy:

- **Periodic grab** (every 60s): starts a quick P2P stream, captures one frame, stops
- **Person/ring hold**: when a person or ring is detected, holds the event snapshot for 10 minutes before resuming periodic grabs
- **Livestream capture**: grabs a frame from the first video data of any active stream
- **Event refresh**: after detection events, refreshes from Eufy cloud after 3s
- **Startup**: caches the `picture` property (last event JPEG) on device discovery

## Important Notes

- Uses a **secondary Eufy account** (only one client can connect at a time)
- The E340 does NOT support RTSP — P2P only
- Keep the HomeBase on Ethernet
- Set Streaming Quality to LOW in the Eufy app
- Eufy firmware updates are automatic and can break P2P
- Keep push notifications enabled in the Eufy app

## Dashboard

Web dashboard at `http://<vm-ip>` (or via Tailscale at `http://doorbell:80`).

- System status bar (uptime, device, DB size, event count)
- Event count stat cards by type for selected period
- Hourly activity chart (24h/7d/30d/All)
- Known faces with visit counts
- Daily summary table (7d/30d/90d)
- Filterable event timeline with search
- CSV and JSON export with date range filtering

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard HTML |
| `GET /api/events?type=&limit=` | Recent events (filterable by type) |
| `GET /api/stats?period=` | Event counts by type |
| `GET /api/hours?period=` | Hourly activity breakdown |
| `GET /api/faces?period=` | Known face visit counts |
| `GET /api/daily?period=` | Daily summary by type |
| `GET /api/search?q=&limit=` | Search event details |
| `GET /api/status` | System health (uptime, device, DB size) |
| `GET /api/export?format=csv\|json&type=&from=&to=` | Download events |

## Files

| File | Description |
|---|---|
| [VM Setup](vm-setup.md) | QEMU VM configuration and management |
| [Troubleshooting](troubleshooting.md) | Common issues and fixes |
| [Research Notes](custom-vm-research.md) | Original research into replacing HAOS |
| [src/doorbell.js](src/doorbell.js) | Main application source |
| [src/dashboard.html](src/dashboard.html) | Web dashboard |
| [src/package.json](src/package.json) | npm dependencies |
| [src/.env.example](src/.env.example) | Credentials template |
| [vm/](vm/) | VM infrastructure (start script, LaunchDaemon, OpenRC service) |

## Disclaimer

This project is not affiliated with, endorsed by, or associated with Anker/Eufy or Apple. "Eufy", "HomeBase", "HomeKit", and "Apple Home" are trademarks of their respective owners. This is an independent, community-driven integration.

## License

[MIT](LICENSE)
