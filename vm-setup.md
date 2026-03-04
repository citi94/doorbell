# Doorbell VM Setup

## Host: 2018 Mac Mini

- CPU: Intel i5-8500B @ 3.00GHz (6 cores)
- RAM: 32GB
- macOS 15.7.4 (Sequoia)
- QEMU installed via Homebrew: `/usr/local/bin/qemu-system-x86_64`
- Networking: `socket_vmnet` (bridged to `en0`)

## VM Specs

- Alpine Linux 3.21 (alpine-virt)
- 1 vCPU, 512MB RAM
- Disk: 4GB QCOW2
- EFI boot via `edk2-x86_64-code.fd` (code) + `edk2-i386-vars.fd` (vars)
- MAC address: `52:54:00:XX:XX:XX` (choose a unique locally-administered MAC)
- Static IP: `<vm-ip>`
- Bridged networking via `socket_vmnet` instance (socket: `/usr/local/var/run/socket_vmnet_doorbell`)

## File Locations

| File | Path |
|---|---|
| VM disk image | `/var/lib/doorbell-vm/disk.qcow2` |
| EFI vars | `/var/lib/doorbell-vm/efi_vars.fd` |
| Start script | `/usr/local/bin/doorbell-vm-start.sh` |
| LaunchDaemon | `/Library/LaunchDaemons/com.doorbell.qemu.plist` |
| Boot log | `/var/log/doorbell-vm-start.log` |
| Stdout log | `/var/log/doorbell-qemu.log` |
| Stderr log | `/var/log/doorbell-qemu.err` |

## Inside the VM

| File | Purpose |
|---|---|
| `/opt/doorbell/doorbell.js` | Main application |
| `/opt/doorbell/dashboard.html` | Web dashboard |
| `/opt/doorbell/package.json` | npm dependencies |
| `/opt/doorbell/.env` | Credentials (not in source control) |
| `/opt/doorbell/events.db` | SQLite event database |
| `/opt/doorbell/persist/` | eufy-security-client persistent tokens |
| `/etc/init.d/doorbell` | OpenRC service script (supervise-daemon) |
| `/usr/local/bin/ffmpeg-hk` | Homebridge ffmpeg build (libfdk_aac for AAC-ELD audio) |
| `/var/log/doorbell.log` | Application log |

## Installed Packages

- `nodejs` (v22.15.1), `npm`
- `ffmpeg` (v6.1.2)
- `tailscale` (v1.94.2, installed from static binary)
- `python3`, `curl`, `openssh`

## Management Commands

```bash
# Stop the VM
sudo launchctl bootout system /Library/LaunchDaemons/com.doorbell.qemu.plist

# Start the VM
sudo launchctl bootstrap system /Library/LaunchDaemons/com.doorbell.qemu.plist

# Check if running
ps aux | grep qemu | grep doorbell

# View boot log
tail -50 /var/log/doorbell-vm-start.log

# SSH in (local, key auth only)
ssh root@<vm-ip>

# SSH in (remote, via Tailscale)
tailscale ssh root@doorbell
```

## Service Management (inside VM)

```bash
# Restart the doorbell app
rc-service doorbell restart

# View app logs
tail -f /var/log/doorbell.log

# Check all services
rc-status default

# Update the app (from Mac host)
scp ~/projects/doorbell/src/doorbell.js ~/projects/doorbell/src/dashboard.html root@<vm-ip>:/opt/doorbell/
ssh root@<vm-ip> 'rc-service doorbell restart'
```

## SSH Access

- **Local**: key auth only (`PasswordAuthentication no`, `PermitRootLogin prohibit-password`)
- **Remote**: Tailscale SSH (ACL-controlled, `tag:doorbell` allows root)
- **Root password**: disabled (unusable)
- **Authorized key**: your ED25519 public key

## Tailscale

- Hostname: `doorbell` (`doorbell.<tailnet>.ts.net`)
- Tagged: `tag:doorbell` (allows root SSH via ACL)
- DNS: MagicDNS (100.100.100.100) while Tailscale is running

## EFI Vars Note

The EFI vars file must be copied from `edk2-i386-vars.fd` (NOT `edk2-x86_64-code.fd`):

```bash
sudo cp /usr/local/share/qemu/edk2-i386-vars.fd /var/lib/doorbell-vm/efi_vars.fd
```

## Pi-hole VM (Reference)

Runs alongside on the same host:
- Start script: `/usr/local/bin/pihole-vm-start.sh`
- LaunchDaemon: `/Library/LaunchDaemons/com.pihole.qemu.plist`
- Disk: `/var/lib/pihole-vm/disk-fresh.qcow2`
- Ubuntu, 384MB RAM, 1 vCPU
- MAC: `<pihole-mac>`
- Uses its own `socket_vmnet` on `/usr/local/var/run/socket_vmnet`
