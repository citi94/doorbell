#!/bin/bash
# Doorbell VM startup script for Mac Mini (x86_64)
# Install to: /usr/local/bin/doorbell-vm-start.sh
LOG=/var/log/doorbell-vm-start.log
exec > $LOG 2>&1

echo "$(date): Waiting for network..."
for i in {1..120}; do
    IP=$(ipconfig getifaddr en0 2>/dev/null)
    if [ -n "$IP" ]; then
        echo "$(date): en0 has IP $IP after ${i}s"
        break
    fi
    sleep 1
done

sleep 5

mkdir -p /usr/local/var/run

SOCK=/usr/local/var/run/socket_vmnet_doorbell
rm -f "$SOCK"

echo "$(date): Starting socket_vmnet for doorbell..."
/usr/local/opt/socket_vmnet/bin/socket_vmnet --vmnet-mode=bridged --vmnet-interface=en0 "$SOCK" &
VMNET_PID=$!
sleep 3

echo "$(date): Starting doorbell QEMU VM..."
/usr/local/opt/socket_vmnet/bin/socket_vmnet_client "$SOCK" \
    /usr/local/bin/qemu-system-x86_64 \
    -machine q35,accel=hvf -cpu host -smp 1 -m 512 \
    -device virtio-rng-pci \
    -drive if=pflash,format=raw,file=/usr/local/share/qemu/edk2-x86_64-code.fd,readonly=on \
    -drive if=pflash,format=raw,file=/var/lib/doorbell-vm/efi_vars.fd \
    -device virtio-blk-pci,drive=disk0 \
    -drive id=disk0,if=none,format=qcow2,file=/var/lib/doorbell-vm/disk.qcow2 \
    -device virtio-net-pci,netdev=net0,mac=52:54:00:XX:XX:XX  # Replace with your chosen MAC address \
    -netdev socket,id=net0,fd=3 \
    -nographic -serial mon:stdio &

wait
