# Doorbell VM Setup Guide

## Prerequisites

- QEMU installed: `/usr/local/bin/qemu-system-x86_64`
- socket_vmnet installed: `/usr/local/opt/socket_vmnet/bin/socket_vmnet`
- Both already present from existing Pi-hole and HAOS VMs

## Step 1: Create VM disk and download Alpine ISO

```bash
sudo mkdir -p /var/lib/doorbell-vm
sudo qemu-img create -f qcow2 /var/lib/doorbell-vm/disk.qcow2 4G
sudo cp /usr/local/share/qemu/edk2-i386-vars.fd /var/lib/doorbell-vm/efi_vars.fd
curl -o /tmp/alpine-virt-3.21.6-x86_64.iso \
  https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-virt-3.21.6-x86_64.iso
```

## Step 2: Boot from ISO and install Alpine

```bash
sudo /usr/local/bin/qemu-system-x86_64 \
  -machine q35,accel=hvf -cpu host -smp 1 -m 512 \
  -device virtio-rng-pci \
  -drive if=pflash,format=raw,file=/usr/local/share/qemu/edk2-x86_64-code.fd,readonly=on \
  -drive if=pflash,format=raw,file=/var/lib/doorbell-vm/efi_vars.fd \
  -device virtio-blk-pci,drive=disk0 \
  -drive id=disk0,if=none,format=qcow2,file=/var/lib/doorbell-vm/disk.qcow2 \
  -cdrom /tmp/alpine-virt-3.21.6-x86_64.iso \
  -boot d \
  -device virtio-net-pci,netdev=net0 \
  -netdev user,id=net0 \
  -nographic -serial mon:stdio
```

At the Alpine login prompt (`localhost login:`), log in as `root` (no password), then:

```
setup-alpine
```

Settings:
- Keyboard: us / us
- Hostname: doorbell
- Network: eth0, dhcp (we'll set static later)
- Root password: choose a temporary password
- Timezone: your timezone
- Mirror: CDN (f)
- SSH server: openssh
- Disk: vda, sys
- Erase disk: y

After install completes:
```
poweroff
```

## Step 3: Boot installed disk and configure

Boot with user-mode networking (port forward SSH to host 2222):

```bash
sudo /usr/local/bin/qemu-system-x86_64 \
  -machine q35,accel=hvf -cpu host -smp 1 -m 512 \
  -device virtio-rng-pci \
  -drive if=pflash,format=raw,file=/usr/local/share/qemu/edk2-x86_64-code.fd,readonly=on \
  -drive if=pflash,format=raw,file=/var/lib/doorbell-vm/efi_vars.fd \
  -device virtio-blk-pci,drive=disk0 \
  -drive id=disk0,if=none,format=qcow2,file=/var/lib/doorbell-vm/disk.qcow2 \
  -device virtio-net-pci,netdev=net0 \
  -netdev user,id=net0,hostfwd=tcp::2222-:22 \
  -nographic -serial mon:stdio
```

Log in as root, then configure:

### Enable community repo
```bash
sed -i 's|#.*community|http://dl-cdn.alpinelinux.org/alpine/v3.21/community|' /etc/apk/repositories
apk update
```

### Install packages
```bash
apk add nodejs npm ffmpeg python3 curl
```

### Set static IP
```bash
cat > /etc/network/interfaces << 'EOF'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet static
    address <vm-ip>
    netmask 255.255.255.0
    gateway <gateway-ip>
EOF

cat > /etc/resolv.conf << 'EOF'
nameserver <dns-ip>
nameserver 1.1.1.1
EOF
```

### Enable SSH
```bash
rc-update add sshd default
```

### Create app directory
```bash
mkdir -p /opt/doorbell/persist
```

### Shutdown
```bash
poweroff
```

## Step 4: Install start script and LaunchDaemon (on Mac host)

```bash
sudo cp vm/doorbell-vm-start.sh /usr/local/bin/doorbell-vm-start.sh
sudo chmod +x /usr/local/bin/doorbell-vm-start.sh
sudo cp vm/com.doorbell.qemu.plist /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/com.doorbell.qemu.plist
```

Wait for boot, then verify:
```bash
ping <vm-ip>
ssh root@<vm-ip>
```

## Step 5: Deploy the Node.js app (from Mac host)

```bash
scp src/package.json root@<vm-ip>:/opt/doorbell/
scp src/doorbell.js root@<vm-ip>:/opt/doorbell/
scp src/.env.example root@<vm-ip>:/opt/doorbell/.env
```

Then SSH in and configure:
```bash
ssh root@<vm-ip>

# Edit .env with real credentials
vi /opt/doorbell/.env

# Install npm dependencies
cd /opt/doorbell
npm install --production

# Install and start the service
cp /path/to/doorbell.initd /etc/init.d/doorbell
# OR scp it from Mac:
# (from Mac) scp vm/doorbell.initd root@<vm-ip>:/etc/init.d/doorbell

chmod +x /etc/init.d/doorbell
rc-update add doorbell default
rc-service doorbell start

# Check logs
tail -f /var/log/doorbell.log
```

## Step 6: Pair with HomeKit

1. Open Apple Home on iPhone
2. Tap + → Add Accessory
3. Enter the pairing code from your `.env` file (or scan if QR available)
4. The doorbell should appear as a VIDEO_DOORBELL category accessory

## Testing

- Ring the doorbell → HomePods should chime
- Walk past camera → Motion detected in Apple Home
- Tap camera tile → Live video should load
- Check logs: `ssh root@<vm-ip> 'tail -50 /var/log/doorbell.log'`

## Management

```bash
# Stop VM
sudo launchctl unload /Library/LaunchDaemons/com.doorbell.qemu.plist

# Start VM
sudo launchctl load /Library/LaunchDaemons/com.doorbell.qemu.plist

# Restart doorbell service (inside VM)
ssh root@<vm-ip> 'rc-service doorbell restart'

# View logs
ssh root@<vm-ip> 'tail -100 /var/log/doorbell.log'
```
