# Custom Lightweight Doorbell VM — Research Notes

## Problem

The HAOS VM (4GB RAM, 5 Docker containers) crashes every 8-27 hours on QEMU/HVF on macOS. The crash pattern is: CPU spikes to 100%, all services become unresponsive. This happens with or without the P2P video stream running. The Pi-hole VM on the same host (384MB, Alpine Linux) has been stable for weeks. The root cause appears to be an intermittent HVF bug triggered by the complexity/load of HAOS, not by any single component.

## Requirements

1. Doorbell rings → HomePods play chime sound
2. Live video/audio stream viewable from Apple Home
3. Motion/person/pet detection events visible in HomeKit
4. Stable — no crashes
5. Debuggable — no black box layers

## Research Findings (March 2026)

### eufy-security-client (Node.js library by bropat)

- Core library that handles Eufy cloud auth, device discovery, P2P to HomeBase
- Can be used directly in a Node.js app (no need for eufy-security-ws WebSocket wrapper)
- Emits events: `device rings`, `device motion detected`, `device person detected`
- On livestream start, provides raw H.264 video and AAC audio as Node.js `Readable` streams
- Much more efficient than eufy-security-ws which JSON-serializes every byte of video
- GitHub: https://github.com/bropat/eufy-security-client
- Current version: v3.8.0
- Requires secondary Eufy account (same as HA setup)
- Node.js version sensitivity: must use 20.11.0 or 24.5.0+ for P2P (PKCS1 issue), or use `--security-revert=CVE-2023-46809`

### HAP-nodejs (HomeKit Accessory Protocol)

- Node.js library for creating native HomeKit accessories
- Has `DoorbellController` class that extends `CameraController`
- `doorbellController.ringDoorbell()` fires `ProgrammableSwitchEvent.SINGLE_PRESS` → HomePods chime
- Critical: must set `Categories.VIDEO_DOORBELL` (not CAMERA) for proper HomePod chime
- The Homebridge eufy plugin gets this WRONG (sets CAMERA, closed as NOT_PLANNED) — we get it right
- Video streaming: HAP-nodejs negotiates SRTP params, we spawn ffmpeg to transcode H.264 → SRTP
- Needs ffmpeg for video transcoding to HomeKit format
- GitHub: https://github.com/homebridge/HAP-NodeJS
- Current version: v2.1.0

### go2rtc (standalone Go binary)

- Receives RTSP streams, serves them to consumers
- Can accept H.264 input via exec source or RTSP publish
- Single static binary, ~10MB, no dependencies
- Already proven in our HA setup on port 8554
- GitHub: https://github.com/AlexxIT/go2rtc

### Homebridge Route — NOT Recommended

- homebridge-eufy-security plugin v4.5.0 supports E340
- BUT has `VIDEO_DOORBELL` category bug — sets CAMERA instead, HomePod chime unreliable
- Maintainers closed the bug as NOT_PLANNED
- Adds unnecessary Homebridge runtime overhead for a single accessory
- Going direct with HAP-nodejs is lighter and correct

### Alpine Linux VM

- alpine-virt ISO: 68MB, purpose-built for VMs
- Idles at ~30-40MB RAM
- Node.js 22 LTS in the v3.21 main repo
- ffmpeg in community repo
- Boots in 2-4 seconds
- OpenRC init (simpler than systemd)
- Cloud-init supported for automated provisioning
- Same QEMU/HVF setup as the stable Pi-hole VM

## Architecture

```
Current HAOS (crashes):
  Doorbell → HomeBase → Eufy Cloud → eufy-security-ws (Docker container)
    → eufy_security integration (Docker container) → go2rtc (Docker container)
    → HA stream component → HomeKit Bridge → Apple Home → HomePods
  4GB RAM, 5 Docker containers, Supervisor orchestrator, database

Proposed Custom VM (lightweight):
  Doorbell → HomeBase → eufy-security-client (in-process Node.js)
    → HAP-nodejs DoorbellController → Apple Home → HomePods
    → go2rtc (for video relay) → ffmpeg → SRTP to HomeKit
  512MB RAM, 2 processes (Node.js + go2rtc), fully debuggable
```

## Resource Estimates

| Component | Idle RAM | Peak (streaming) |
|---|---|---|
| Alpine Linux base | ~35 MB | ~45 MB |
| Node.js app (eufy-client + HAP-nodejs) | ~50 MB | ~120 MB |
| ffmpeg (1 transcode) | ~0 MB (not running) | ~80 MB |
| go2rtc | ~20 MB | ~80 MB |
| **Total** | **~105 MB** | **~325 MB** |

512MB VM allocation provides comfortable headroom.

## VM Details

- IP: `<vm-ip>` (choose a free static IP on your LAN)
- MAC: `52:54:00:XX:XX:XX` (choose a unique locally-administered MAC)
- RAM: 512MB
- vCPU: 1
- Disk: 4GB qcow2
- OS: Alpine Linux 3.21 (alpine-virt)
- QEMU: same flags as Pi-hole VM
