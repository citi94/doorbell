# QEMU VM Setup on macOS

This guide sets up an Ubuntu 24.04 LTS VM on a Mac using QEMU with HVF (Hypervisor.framework) acceleration. This is the recommended approach for running the doorbell bridge on a Mac Mini or Mac Studio homelab.

If you're running on bare metal Linux (Raspberry Pi, NUC, etc.), see [bare-metal.md](bare-metal.md) instead.

## Prerequisites

Install QEMU and socket_vmnet via Homebrew:

```bash
brew install qemu
brew install socket_vmnet
```

You'll also need `mkisofs` for creating the cloud-init drive:

```bash
brew install cdrtools
```

## Step 1: Download Ubuntu Cloud Image

```bash
curl -L -o /tmp/ubuntu-cloud.img \
  https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
```

Resize the disk to your desired size (6GB recommended):

```bash
qemu-img resize /tmp/ubuntu-cloud.img 6G
```

## Step 2: Create Cloud-Init Drive

Cloud-init automatically provisions the VM on first boot — sets hostname, SSH keys, installs packages, and configures networking.

The config files are in `vm/cloud-init/`. Edit them before proceeding:

**`vm/cloud-init/user-data`** — add your SSH public key:
```yaml
ssh_authorized_keys:
  - ssh-ed25519 AAAA... your-key-here
```

**`vm/cloud-init/network-config`** — set your VM's static IP, MAC address, and gateway:
```yaml
ethernets:
  id0:
    match:
      macaddress: "52:54:00:xx:xx:xx"  # your chosen MAC
    addresses:
      - 192.168.1.x/24                 # your chosen IP
    gateway4: 192.168.1.1              # your gateway
```

Then build the cloud-init ISO:

```bash
mkisofs -output /tmp/cidata.iso -volid cidata -joliet -rock vm/cloud-init/
qemu-img convert -f raw -O qcow2 /tmp/cidata.iso /tmp/cidata.qcow2
```

## Step 3: Prepare VM Directory

```bash
sudo mkdir -p /var/lib/doorbell-vm
sudo cp /tmp/ubuntu-cloud.img /var/lib/doorbell-vm/disk.qcow2
sudo cp /tmp/cidata.qcow2 /var/lib/doorbell-vm/cidata.qcow2
sudo cp /usr/local/share/qemu/edk2-i386-vars.fd /var/lib/doorbell-vm/efi_vars.fd
```

> **Note**: The EFI vars file must be `edk2-i386-vars.fd`, not `edk2-x86_64-code.fd`. Using the wrong file causes QEMU to spin at 100% CPU with no boot.

## Step 4: Configure Start Script

Edit `vm/doorbell-vm-start.sh` and set your MAC address:

```bash
-device virtio-net-pci,netdev=net0,mac=52:54:00:xx:xx:xx \
```

Choose a unique locally-administered MAC address (anything starting with `52:54:00:` works).

Install the start script:

```bash
sudo cp vm/doorbell-vm-start.sh /usr/local/bin/doorbell-vm-start.sh
sudo chmod +x /usr/local/bin/doorbell-vm-start.sh
```

**Optional**: Create a named QEMU symlink so the process shows a recognizable name in Activity Monitor:

```bash
sudo ln -sf $(readlink -f $(which qemu-system-x86_64)) /usr/local/bin/qemu-doorbell
```

Then change the start script to use `/usr/local/bin/qemu-doorbell` instead of `/usr/local/bin/qemu-system-x86_64`.

## Step 5: Install LaunchDaemon

This starts the VM automatically on boot:

```bash
sudo cp vm/com.doorbell.qemu.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/com.doorbell.qemu.plist
```

Wait 2-3 minutes for cloud-init to complete (it installs Node.js 22, ffmpeg, and configures the system). Then SSH in:

```bash
ssh root@<vm-ip>
```

> If the host key has changed from a previous VM at the same IP: `ssh-keygen -R <vm-ip>`

## Step 6: Post-Boot Setup

SSH into the VM and complete the setup:

### Install ffmpeg-hk

HomeKit audio requires AAC-ELD encoding/decoding, which needs `libfdk_aac`. The standard ffmpeg doesn't include it. Download the [homebridge static build](https://github.com/homebridge/ffmpeg-for-homebridge):

```bash
curl -L -o /usr/local/bin/ffmpeg-hk \
  https://github.com/homebridge/ffmpeg-for-homebridge/releases/latest/download/ffmpeg-linux-x86_64
chmod +x /usr/local/bin/ffmpeg-hk
```

### Install Tailscale (optional, for remote access)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname=doorbell
```

### Create non-root user

For security, create a regular user and disable root SSH login:

```bash
useradd -m -s /bin/bash -G sudo doorbell
mkdir -p /home/doorbell/.ssh
cp /root/.ssh/authorized_keys /home/doorbell/.ssh/
chown -R doorbell:doorbell /home/doorbell/.ssh
chmod 700 /home/doorbell/.ssh
chmod 600 /home/doorbell/.ssh/authorized_keys
echo "doorbell ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/doorbell
chmod 440 /etc/sudoers.d/doorbell
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

After this, SSH in as `doorbell@<vm-ip>` with `sudo` for admin commands.

### Disable unnecessary services

Ubuntu cloud images include services that waste RAM on a small VM:

```bash
sudo systemctl disable --now fwupd fwupd-refresh.timer
sudo systemctl disable --now snapd snapd.socket snapd.seeded
sudo systemctl disable --now ModemManager multipathd udisks2
```

> `fwupd` alone uses ~165MB and can trigger the OOM killer on a 512MB VM.

### Add swap

```bash
sudo fallocate -l 512M /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
```

## Step 7: Deploy the App

From the Mac host:

```bash
scp src/doorbell.js src/dashboard.html src/package.json doorbell@<vm-ip>:/opt/doorbell/
scp src/.env.example doorbell@<vm-ip>:/opt/doorbell/.env
```

SSH into the VM and configure:

```bash
ssh doorbell@<vm-ip>

# Edit .env with your real credentials
sudo vi /opt/doorbell/.env

# Install npm dependencies
cd /opt/doorbell && sudo npm install --production

# Install and enable the systemd service
sudo cp /path/to/vm/doorbell.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now doorbell

# Check logs
sudo tail -f /var/log/doorbell.log
```

## Step 8: Pair with HomeKit

1. Open Apple Home on your iPhone
2. Tap **+** → **Add Accessory**
3. Enter the pairing code from your `.env` file
4. The doorbell appears as a VIDEO_DOORBELL accessory with three motion sensors (Motion, Person, Pet)

## Step 9: Install Watchdog (Optional)

The host-side watchdog monitors the VM and restarts QEMU if it becomes unresponsive:

```bash
sudo cp vm/doorbell-watchdog.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/doorbell-watchdog.sh
sudo cp vm/com.doorbell.watchdog.plist /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/com.doorbell.watchdog.plist
```

Install log rotation for the watchdog:

```bash
sudo cp vm/doorbell-watchdog.newsyslog.conf /etc/newsyslog.d/
```

## Management Commands

### Host (macOS)

```bash
# Stop the VM
sudo launchctl bootout system/com.doorbell.qemu

# Start the VM
sudo launchctl bootstrap system /Library/LaunchDaemons/com.doorbell.qemu.plist

# Check if running
ps aux | grep qemu-doorbell

# View boot log
tail -50 /var/log/doorbell-vm-start.log

# View watchdog log
tail -50 /var/log/doorbell-watchdog.log
```

### Guest (Ubuntu VM)

```bash
# SSH in
ssh doorbell@<vm-ip>                    # local
tailscale ssh doorbell@doorbell         # remote

# Manage the doorbell service
sudo systemctl restart doorbell
sudo systemctl status doorbell
sudo journalctl -u doorbell -f

# View app logs
sudo tail -f /var/log/doorbell.log

# Deploy updated app (from Mac host)
scp src/doorbell.js src/dashboard.html doorbell@<vm-ip>:/opt/doorbell/
ssh doorbell@<vm-ip> 'sudo systemctl restart doorbell'

# Check memory and slab health
free -m
grep Slab /proc/meminfo
```

## File Locations

### Host (macOS)

| File | Purpose |
|---|---|
| `/var/lib/doorbell-vm/disk.qcow2` | VM disk image |
| `/var/lib/doorbell-vm/cidata.qcow2` | Cloud-init data drive |
| `/var/lib/doorbell-vm/efi_vars.fd` | EFI variables |
| `/usr/local/bin/doorbell-vm-start.sh` | QEMU start script |
| `/usr/local/bin/doorbell-watchdog.sh` | Host watchdog script |
| `/Library/LaunchDaemons/com.doorbell.qemu.plist` | VM LaunchDaemon |
| `/Library/LaunchDaemons/com.doorbell.watchdog.plist` | Watchdog LaunchDaemon |
| `/var/log/doorbell-vm-start.log` | QEMU boot log |
| `/var/log/doorbell-watchdog.log` | Watchdog log |

### Guest (Ubuntu VM)

| File | Purpose |
|---|---|
| `/opt/doorbell/doorbell.js` | Main application |
| `/opt/doorbell/dashboard.html` | Web dashboard |
| `/opt/doorbell/package.json` | npm dependencies |
| `/opt/doorbell/.env` | Credentials (not in source control) |
| `/opt/doorbell/events.db` | SQLite event database |
| `/opt/doorbell/persist/` | HomeKit pairing state + eufy tokens |
| `/etc/systemd/system/doorbell.service` | systemd service unit |
| `/usr/local/bin/ffmpeg-hk` | Homebridge ffmpeg (libfdk_aac) |
| `/var/log/doorbell.log` | Application log |

## Why Ubuntu, Not Alpine?

This project originally ran on Alpine Linux 3.21 (kernel 6.12). Alpine's minimal footprint seemed ideal for a 512MB VM, but the kernel had a slab memory leak: `maple_node` and `vm_area_struct` objects accumulated from the constant ffmpeg process spawning (~1,440/day for snapshot grabs) and were never freed.

Slab memory grew from ~20MB to 340MB+ over 8-12 hours, exhausting guest RAM and causing the VM to freeze. Ubuntu 24.04 (kernel 6.8) with Canonical's kernel patches handles the same workload with stable 50-70MB slab indefinitely.

**Lesson**: Alpine is excellent for containers and lightweight static workloads. For heavy process churn (frequent fork/exec), Ubuntu's battle-tested kernel is more reliable.
