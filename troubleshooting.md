# Troubleshooting

## VM Won't Boot / Stuck at High CPU

**Symptom**: QEMU process at 99% CPU, no serial output, no network response.

**Cause**: Wrong EFI vars file. The vars must come from `edk2-i386-vars.fd`, not `edk2-x86_64-code.fd`.

**Fix**:
```bash
sudo launchctl bootout system /Library/LaunchDaemons/com.doorbell.qemu.plist
sudo cp /usr/local/share/qemu/edk2-i386-vars.fd /var/lib/doorbell-vm/efi_vars.fd
sudo launchctl bootstrap system /Library/LaunchDaemons/com.doorbell.qemu.plist
```

## Doorbell Service Not Starting

**Symptom**: `rc-service doorbell status` shows stopped.

**Checks**:
1. Check logs: `tail -50 /var/log/doorbell.log`
2. Check if Node.js is installed: `node --version`
3. Check dependencies: `cd /opt/doorbell && npm ls`
4. Check .env is populated: `cat /opt/doorbell/.env`
5. Try running manually: `cd /opt/doorbell && node doorbell.js`

## Eufy Cloud Won't Connect

**Symptom**: Logs show "Eufy connection error" or no "Eufy cloud connected" message.

**Checks**:
1. Is the .env file correct? Check `EUFY_USERNAME` and `EUFY_PASSWORD`
2. Is the secondary Eufy account still valid? Try logging in via the Eufy app
3. Is another client using the same account? Only one client can connect at a time
4. DNS working? `ping google.com` from inside the VM
5. 2FA requested? Check logs for "WARNING: 2FA requested"

## No Doorbell Events / Push Notifications

**Symptom**: No motion or ring events in logs.

**Checks**:
1. Check logs for "Push notification connected"
2. Open Eufy app → ensure push notifications are enabled for the doorbell
3. **IMPORTANT**: Push notifications are account-level, not per-device. Disabling notifications on your phone for the secondary Eufy account will also stop eufy-security-client from receiving events. Always keep notifications enabled for the secondary account.
4. Is the HomeBase online? `ping <homebase-ip>`
5. Eufy app updates can silently disable push notifications
6. Restart the service: `rc-service doorbell restart`

## HomeKit Accessory Not Discoverable

**Symptom**: "Doorbell" doesn't appear in Apple Home when adding accessory.

**Checks**:
1. Are you on the same local network? (mDNS/Bonjour required for pairing)
2. Is the service running? `rc-service doorbell status`
3. Check mDNS from Mac: `dns-sd -B _hap._tcp`
4. Check port 47128 is listening: `ss -tlnp | grep 47128` (inside VM)
5. Try restarting the service: `rc-service doorbell restart`

## HomePods Don't Chime on Ring

**Symptom**: Doorbell ring detected in logs but HomePods don't play chime.

**Cause**: The accessory must be `Categories.VIDEO_DOORBELL` (not CAMERA). Check that `doorbell.js` uses category 18.

**Other checks**:
1. Is the doorbell paired in Apple Home?
2. Are HomePods set as home hubs? (Settings → Home → Home Hubs)
3. Logs should show "DOORBELL RING — triggering HomeKit chime"

## Video Stream Not Working

**Symptom**: Tapping camera in Apple Home shows spinner or fails.

**Checks**:
1. Is ffmpeg installed? `ffmpeg -version`
2. Check logs for ffmpeg errors after tapping the camera
3. Is the P2P connection working? Logs should show "Livestream started"
4. Set streaming quality to LOW in Eufy app
5. Ensure eufy-security-client is v3.8.0+ (ECDH fix for E340)

## Firmware Update Broke Integration

**Symptom**: Service stops working after Eufy firmware auto-update.

**Notes**:
- Eufy firmware updates are automatic and cannot be disabled
- They regularly break third-party P2P integrations
- Check GitHub issues for eufy-security-client for known issues
- Update the dependency: `cd /opt/doorbell && npm update eufy-security-client`
- Then restart: `rc-service doorbell restart`

## Eufy App Logged Out on Phone

**Cause**: eufy-security-client forces single-session login. If you used your primary account, it logs out the phone.

**Fix**: The .env should use a **secondary** Eufy account. Share devices from primary to secondary with admin rights.

## Node.js Timer Assertion Crash

**Symptom**: Log shows `Assertion failed: (now) >= (timer_base())` and the service crash-loops.

**Cause**: QEMU HVF's `tsc` clocksource can cause the monotonic clock to go backwards, triggering a fatal Node.js assertion.

**Fix**: Switch the VM to the `acpi_pm` clocksource:
```bash
echo acpi_pm > /sys/devices/system/clocksource/clocksource0/current_clocksource
```

This is persisted via `/etc/local.d/clocksource.start`. If it recurs after a reboot, check that the `local` service is enabled: `rc-update add local default`.

If already crash-looping, reboot the VM from the Mac host:
```bash
sudo launchctl bootout system/com.doorbell.qemu
sudo launchctl bootstrap system /Library/LaunchDaemons/com.doorbell.qemu.plist
```

## Snapshot Shows Old Image

**Symptom**: HomeKit thumbnail shows a stale or outdated image.

**How it works**: Snapshots are grabbed via quick P2P streams every 60s. After a person/ring detection, the event image is held for 10 minutes before periodic grabs resume.

**Checks**:
1. Check logs for `Snapshot grabbed from P2P` — confirms periodic grabs are working
2. Check logs for `Snapshot cached from picture property` — confirms event images are being cached
3. If no grabs: is the device connected? Check `Target device found` in logs
4. If grabs fail: check `Snapshot grab — timeout` — P2P may be unreliable

## Two-Way Audio (Talkback) Not Working

**Symptom**: Mic button appears in Apple Home but no audio plays from doorbell speaker.

**Checks**:
1. Check logs for `Talkback started — piping return audio` — confirms talkback connected
2. Check for `ffmpeg-return` errors — the return audio ffmpeg decodes AAC-ELD from HomeKit
3. The decoder must be `libfdk_aac` (not the built-in `aac` which can't decode AAC-ELD with Low Delay SBR)
4. Check `Talkback error` or `Talkback stopped by station` in logs
5. Restart the service: `rc-service doorbell restart`

**Audio pipeline**: HomeKit mic → AAC-ELD SRTP → ffmpeg-hk (libfdk_aac decode) → AAC-LC ADTS → eufy TalkbackStream → doorbell speaker

## HVF Idle-Spin (VM at ~100% CPU While Idle)

**Symptom**: QEMU process at ~95% CPU even when idle.

**Cause**: macOS HVF idle-spin bug with multiple vCPUs.

**Fix**: Use 1 vCPU (already the default in doorbell-vm-start.sh).

## Useful Commands

```bash
# SSH into VM (local)
ssh root@<vm-ip>

# SSH into VM (remote via Tailscale)
tailscale ssh root@doorbell

# View app logs
ssh root@<vm-ip> 'tail -50 /var/log/doorbell.log'

# Restart the app
ssh root@<vm-ip> 'rc-service doorbell restart'

# Check VM from Mac
ps aux | grep qemu | grep doorbell
tail -50 /var/log/doorbell-vm-start.log
ping <vm-ip>

# Check all services inside VM
ssh root@<vm-ip> 'rc-status default'

# Check memory inside VM
ssh root@<vm-ip> 'free -m'

# Deploy updated app
scp ~/projects/doorbell/src/doorbell.js ~/projects/doorbell/src/dashboard.html root@<vm-ip>:/opt/doorbell/
ssh root@<vm-ip> 'rc-service doorbell restart'

# Open dashboard
open http://<vm-ip>
```
