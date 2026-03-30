# Eufy E340 Doorbell → Apple HomeKit Bridge

A custom Node.js bridge that connects a Eufy Video Doorbell E340 (T8214) + HomeBase S380 (T8030) directly to Apple HomeKit — no Home Assistant, no Homebridge, no Docker containers.

Built because the official Eufy integration via Home Assistant OS crashed every 8-27 hours, and the Homebridge eufy plugin has a [known bug](https://github.com/homebridge-eufy-security/plugin/issues) that sets the accessory category to CAMERA instead of VIDEO_DOORBELL, breaking HomePod chime notifications.

## Features

- **Doorbell ring** → HomePods play chime sound
- **Live video + audio** streaming via P2P → ffmpeg → SRTP
- **Two-way audio** (talkback) — speak through Apple Home to the doorbell speaker
- **Motion sensors** — separate Person, Pet, and Motion sensors in HomeKit with independent notifications
- **Real camera snapshots** for HomeKit thumbnails and rich notifications
- **Event logging** to SQLite with web dashboard, search, charts, and CSV/JSON export
- **Auto-reconnect** with exponential backoff
- **Optional HTTP Basic Auth** for dashboard protection

## Architecture

```
Eufy E340 Doorbell
       | (WiFi Direct)
       v
HomeBase S380
       | (P2P over LAN + Eufy Cloud push notifications)
       v
Node.js app (single process)
  ├── eufy-security-client — P2P connection, event handling
  ├── @homebridge/hap-nodejs — DoorbellController (VIDEO_DOORBELL category)
  │     ├── ringDoorbell() → HomePods chime
  │     ├── MotionDetected → Motion / Person / Pet sensors
  │     └── Video/audio → ffmpeg → SRTP → Apple Home
  ├── ffmpeg-hk — AAC-ELD encode/decode for HomeKit audio + talkback
  ├── SQLite — event database (Node.js 22 built-in)
  └── HTTP server — dashboard + REST API (port 80)
```

## Quick Start

There are three ways to run this:

| Setup | Guide | Best for |
|---|---|---|
| **QEMU VM on macOS** | [vm-setup.md](vm-setup.md) | Mac Mini / Mac Studio homelab |
| **Bare metal Linux** | [bare-metal.md](bare-metal.md) | Raspberry Pi, NUC, any Linux box |
| **Any Linux VM** | [bare-metal.md](bare-metal.md) + your hypervisor docs | Proxmox, ESXi, etc. |

Docker is **not supported** — HomeKit requires mDNS (Bonjour) on the local network, which doesn't work reliably in Docker's network namespace.

## Key Constraints

Before you start, understand these limitations:

- **Secondary Eufy account required** — only one client can connect via P2P at a time. Create a second Eufy account, share your doorbell to it with admin rights, and use those credentials in `.env`
- **E340 has NO RTSP** — P2P streaming only, via the HomeBase
- **HomeBase must be on Ethernet** — WiFi adds latency and drops P2P connections
- **Set streaming quality to LOW** in the Eufy app for the secondary account
- **Keep Eufy push notifications enabled** — the app relies on Eufy's push system for motion/ring events. Disabling notifications on your phone kills the event feed. Instead, disable Eufy notifications at the iOS level (Settings → Notifications → Eufy Security → off)
- **Firmware updates are automatic** and can break P2P at any time

## Dashboard

Web dashboard at `http://<your-ip>` with optional Basic Auth (`DASHBOARD_PASSWORD` in `.env`).

- System status bar (uptime, device, DB size, event count)
- Stat cards by event type for selected period
- Hourly activity chart (24h / 7d / 30d / All)
- Known faces with visit counts
- Daily summary table
- Filterable event timeline with search
- CSV and JSON export with date range filtering

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard HTML |
| `GET /api/events?type=&limit=` | Recent events (filterable) |
| `GET /api/stats?period=` | Event counts by type |
| `GET /api/hours?period=` | Hourly activity breakdown |
| `GET /api/faces?period=` | Known face visit counts |
| `GET /api/daily?period=` | Daily summary by type |
| `GET /api/search?q=&limit=` | Search event details |
| `GET /api/status` | System health |
| `GET /api/export?format=csv\|json&type=&from=&to=` | Export events |

## What Doesn't Work

- **HomeKit Secure Video** — would require an iCloud integration that Apple doesn't expose to third-party accessories
- **Multiple simultaneous streams** — HomeKit only allows one live viewer at a time (Apple limitation, not ours)

## Configuration

Copy `src/.env.example` to `.env` and fill in your values:

```bash
cp src/.env.example /opt/doorbell/.env
```

| Variable | Description |
|---|---|
| `EUFY_USERNAME` | Secondary Eufy account email |
| `EUFY_PASSWORD` | Secondary Eufy account password |
| `EUFY_COUNTRY` | Country code (US, GB, etc.) |
| `DEVICE_SERIAL` | E340 serial number (found in Eufy app or logs) |
| `HOMEKIT_PIN` | Pairing code, format: `XXX-XX-XXX` |
| `HOMEKIT_USERNAME` | HomeKit MAC address (unique per accessory) |
| `HOMEKIT_PORT` | HAP server port (default: 47128) |
| `DASHBOARD_PASSWORD` | Optional: password for dashboard Basic Auth |

## Files

| File | Description |
|---|---|
| [src/doorbell.js](src/doorbell.js) | Main application |
| [src/dashboard.html](src/dashboard.html) | Web dashboard |
| [src/package.json](src/package.json) | npm dependencies |
| [src/.env.example](src/.env.example) | Configuration template |
| [vm-setup.md](vm-setup.md) | QEMU VM setup on macOS |
| [bare-metal.md](bare-metal.md) | Running on any Linux machine |
| [troubleshooting.md](troubleshooting.md) | Common issues and fixes |
| [custom-vm-research.md](custom-vm-research.md) | Original research notes |
| [vm/](vm/) | VM infrastructure files |

## Dependencies

| Package | Purpose | License |
|---|---|---|
| [eufy-security-client](https://github.com/bropat/eufy-security-client) v3.8.0 | Eufy cloud auth, P2P, event handling | MIT |
| [@homebridge/hap-nodejs](https://github.com/homebridge/HAP-NodeJS) v2.0.2 | HomeKit accessory protocol | Apache-2.0 |
| [dotenv](https://github.com/motdotla/dotenv) | .env file loading | BSD-2-Clause |
| [pick-port](https://github.com/nickolaev/pick-port) | Dynamic port allocation | MIT |

Also requires:
- **Node.js 22+** (for built-in SQLite via `node:sqlite`)
- **ffmpeg** (standard build, for video transcoding)
- **ffmpeg-hk** (ffmpeg with `libfdk_aac` for AAC-ELD audio encoding/decoding) — the [homebridge static build](https://github.com/homebridge/ffmpeg-for-homebridge) works well

## Disclaimer

This project is not affiliated with, endorsed by, or associated with Anker/Eufy or Apple. "Eufy", "HomeBase", "HomeKit", and "Apple Home" are trademarks of their respective owners. This is an independent, community-driven integration.

## License

[MIT](LICENSE)
