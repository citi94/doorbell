# Running on Bare Metal Linux

This guide is for running the doorbell bridge directly on a Linux machine — no VM, no QEMU. Works on a Raspberry Pi, Intel NUC, old laptop, or any Linux box on the same LAN as your Eufy HomeBase.

For QEMU VM setup on macOS, see [vm-setup.md](vm-setup.md) instead.

## Requirements

- **Linux** — any modern distro (Debian/Ubuntu, Fedora, Arch, etc.)
- **Node.js 22+** — required for built-in SQLite (`node:sqlite`)
- **ffmpeg** — standard build, for video transcoding
- **ffmpeg with libfdk_aac** — for HomeKit AAC-ELD audio (see below)
- **Same LAN** as the Eufy HomeBase — P2P and mDNS must work
- **Port 80** — for the web dashboard (or change in the code)
- **Port 47128** — for HomeKit (configurable via `HOMEKIT_PORT` in `.env`)

## Step 1: Install Node.js 22

### Debian / Ubuntu

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
```

### Fedora

```bash
sudo dnf module install nodejs:22
```

### Arch

```bash
sudo pacman -S nodejs npm
```

### Verify

```bash
node --version  # must be v22.x or later
```

## Step 2: Install ffmpeg

### Debian / Ubuntu

```bash
sudo apt-get install -y ffmpeg
```

### Fedora

```bash
sudo dnf install ffmpeg
```

### Arch

```bash
sudo pacman -S ffmpeg
```

## Step 3: Install ffmpeg-hk (ffmpeg with libfdk_aac)

HomeKit two-way audio requires AAC-ELD encoding and decoding, which needs `libfdk_aac`. The standard system ffmpeg typically doesn't include it.

**Option A: Homebridge static build (easiest)**

```bash
# x86_64
sudo curl -L -o /usr/local/bin/ffmpeg-hk \
  https://github.com/homebridge/ffmpeg-for-homebridge/releases/latest/download/ffmpeg-linux-x86_64

# ARM64 (Raspberry Pi 4/5)
sudo curl -L -o /usr/local/bin/ffmpeg-hk \
  https://github.com/homebridge/ffmpeg-for-homebridge/releases/latest/download/ffmpeg-linux-aarch64

sudo chmod +x /usr/local/bin/ffmpeg-hk
```

**Option B: Build ffmpeg from source with libfdk_aac**

If the static build doesn't work for your architecture, compile ffmpeg with `--enable-libfdk-aac`. See the [FFmpeg compilation guide](https://trac.ffmpeg.org/wiki/CompilationGuide).

**Option C: Skip two-way audio**

If you don't need talkback, the standard system ffmpeg works fine for video streaming and snapshots. Two-way audio simply won't function.

## Step 4: Clone and Configure

```bash
git clone https://github.com/citi94/doorbell.git
cd doorbell

# Create app directory
sudo mkdir -p /opt/doorbell

# Copy app files
sudo cp src/doorbell.js src/dashboard.html src/package.json /opt/doorbell/

# Create and edit .env
sudo cp src/.env.example /opt/doorbell/.env
sudo vi /opt/doorbell/.env  # fill in your credentials

# Install npm dependencies
cd /opt/doorbell && sudo npm install --production
```

See the [README](README.md#configuration) for details on each `.env` variable.

## Step 5: Create systemd Service

```bash
sudo cp vm/doorbell.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doorbell
```

Check it's running:

```bash
sudo systemctl status doorbell
sudo tail -f /var/log/doorbell.log
```

You should see:

```
=== Doorbell service starting ===
Dashboard listening on port 80
Eufy client connected
HomeKit accessory published on port 47128
=== Doorbell service ready ===
```

## Step 6: Pair with HomeKit

1. Make sure your iPhone is on the **same local network** — mDNS/Bonjour is required for initial pairing
2. Open Apple Home → **+** → **Add Accessory**
3. Enter the pairing code from your `.env` file
4. The doorbell appears with three motion sensors: Motion, Person, Pet

## Updating

```bash
cd ~/doorbell  # or wherever you cloned it
git pull
sudo cp src/doorbell.js src/dashboard.html /opt/doorbell/
sudo systemctl restart doorbell
```

## Network Notes

- The machine **must be on the same LAN** as the Eufy HomeBase. The P2P connection is local — it won't work across subnets or VPNs
- HomeKit pairing requires **mDNS** (Bonjour). This works automatically on most Linux setups but may need `avahi-daemon` installed
- After initial pairing, HomeKit remote access works through your Home Hub (HomePod or Apple TV) — the bridge doesn't need to be directly reachable from outside

## Raspberry Pi Notes

- Use a **Pi 4 or Pi 5** — the Pi 3 may struggle with ffmpeg transcoding
- Use the **64-bit Raspberry Pi OS** (Bookworm) — Node.js 22 requires 64-bit
- The homebridge ffmpeg `aarch64` build works on Pi 4/5
- Consider adding a swap file if you only have 1GB RAM:
  ```bash
  sudo fallocate -l 512M /swapfile
  sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
  ```

## Log Rotation

Add log rotation so `/var/log/doorbell.log` doesn't grow unbounded:

```bash
sudo tee /etc/logrotate.d/doorbell > /dev/null << 'EOF'
/var/log/doorbell.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
EOF
```
