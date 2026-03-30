# Troubleshooting

## Doorbell Service Not Starting

**Checks:**
1. View logs: `sudo tail -50 /var/log/doorbell.log`
2. Check systemd status: `sudo systemctl status doorbell`
3. Check Node.js is installed: `node --version` (must be v22+)
4. Check dependencies: `cd /opt/doorbell && npm ls`
5. Check `.env` is populated: `cat /opt/doorbell/.env`
6. Try running manually: `cd /opt/doorbell && sudo node doorbell.js`

## Eufy Cloud Won't Connect

**Symptom:** Logs show "Eufy connection error" or no "Eufy cloud connected" message.

**Checks:**
1. Is `.env` correct? Check `EUFY_USERNAME` and `EUFY_PASSWORD`
2. Is the secondary Eufy account still valid? Try logging in via the Eufy app
3. Is another client using the same account? Only one P2P client can connect at a time
4. DNS working? `ping google.com`
5. 2FA requested? Check logs for "WARNING: 2FA requested"

## No Doorbell Events / Push Notifications

**Symptom:** No motion or ring events in logs.

**Checks:**
1. Look for "Push notification connected" in logs
2. Open Eufy app → ensure push notifications are **enabled** for the doorbell on the secondary account
3. Push notifications are **account-level** — disabling them on your phone kills eufy-security-client events too. To silence Eufy app notifications, disable them at the **iOS level** (Settings → Notifications → Eufy Security → off), not inside the Eufy app
4. Is the HomeBase online? `ping <homebase-ip>`
5. Eufy app updates can silently reset notification settings
6. Restart the service: `sudo systemctl restart doorbell`

## HomeKit Accessory Not Discoverable

**Symptom:** Doorbell doesn't appear in Apple Home when adding accessory.

**Checks:**
1. Are you on the **same local network**? mDNS/Bonjour is required for pairing
2. Is the service running? `sudo systemctl status doorbell`
3. Check mDNS from a Mac: `dns-sd -B _hap._tcp`
4. Check port is listening: `ss -tlnp | grep 47128`
5. On bare metal: is `avahi-daemon` installed and running?
6. Restart the service: `sudo systemctl restart doorbell`

## HomePods Don't Chime on Ring

**Symptom:** Ring detected in logs but HomePods don't play chime.

**Cause:** The accessory must be `Categories.VIDEO_DOORBELL` (category 18), not CAMERA. This is set correctly in the code.

**Other checks:**
1. Is the doorbell paired in Apple Home?
2. Are HomePods set as home hubs? (Settings → Home → Home Hubs)
3. Logs should show "DOORBELL RING — triggering HomeKit chime"

## Video Stream Not Working

**Symptom:** Tapping camera in Apple Home shows spinner or fails.

**Checks:**
1. Is ffmpeg installed? `ffmpeg -version`
2. Check logs for ffmpeg errors after tapping the camera
3. Is the P2P connection working? Logs should show "Livestream started"
4. Set streaming quality to **LOW** in the Eufy app for the secondary account
5. Ensure eufy-security-client is v3.8.0+

## Two-Way Audio (Talkback) Not Working

**Symptom:** Mic button appears in Apple Home but no audio plays from doorbell speaker.

**Checks:**
1. Look for "Talkback started — setting up return audio" in logs
2. Check for `ffmpeg-return` errors — the return audio ffmpeg decodes AAC-ELD from HomeKit
3. Is `ffmpeg-hk` installed? `ffmpeg-hk -version` — it must have `libfdk_aac`
4. The standard `aac` decoder **cannot** decode AAC-ELD (Low Delay SBR not implemented) — `libfdk_aac` is required for both encoding and decoding
5. Check for "Talkback error" or "Talkback stopped by station" in logs

**Audio pipeline:** HomeKit mic → AAC-ELD SRTP → ffmpeg-hk (libfdk_aac decode) → AAC-LC ADTS → eufy TalkbackStream → doorbell speaker

## Motion Sensor Names Show as Numbers

**Symptom:** Motion sensors appear as "1", "2", "3" instead of "Motion", "Person", "Pet".

**Fix:** This usually resolves on its own after a service restart. The code uses `updateCharacteristic(ConfiguredName)` to push names to HomeKit. If it persists, long-press each sensor in the Home app and rename manually.

## Snapshot Shows Old Image

**How snapshots work:** The app grabs a frame via a quick P2P stream every 60 seconds. After a person/ring detection, the event image is held for 10 minutes before periodic grabs resume.

**Checks:**
1. Look for `Snapshot grabbed from P2P` in logs — confirms periodic grabs work
2. Look for `Snapshot cached from picture property` — confirms event images are cached
3. If no grabs: is the device connected? Check for "Target device found" in logs
4. If grabs timeout: P2P to the HomeBase may be unreliable — check HomeBase is on Ethernet

## Firmware Update Broke Integration

**Symptom:** Service stops working after Eufy firmware auto-update.

**Notes:**
- Eufy firmware updates are automatic and cannot be disabled
- They regularly break third-party P2P integrations
- Check [eufy-security-client GitHub issues](https://github.com/bropat/eufy-security-client/issues) for known problems
- Update the dependency: `cd /opt/doorbell && sudo npm update eufy-security-client`
- Restart: `sudo systemctl restart doorbell`

## Out of Memory (OOM Kill)

**Symptom:** `sudo journalctl -u doorbell` shows "oom-kill" or "Killed process".

**Checks:**
1. Check available memory: `free -m`
2. Disable unnecessary services (VMs especially):
   ```bash
   sudo systemctl disable --now fwupd fwupd-refresh.timer  # uses ~165MB!
   sudo systemctl disable --now snapd snapd.socket snapd.seeded
   sudo systemctl disable --now ModemManager multipathd udisks2
   ```
3. Ensure swap is configured: `swapon --show`
4. If on a VM with 512MB RAM, keep the system minimal — the doorbell app uses ~100-120MB at peak

## Disk Full

**Symptom:** Service errors, database write failures, or log messages about "no space".

**Checks:**
1. Check disk usage: `df -h /`
2. Clean apt cache: `sudo apt-get clean`
3. Trim old journals: `sudo journalctl --vacuum-time=3d`
4. Remove old kernels: `sudo apt-get autoremove --purge`
5. Check events database size: `ls -lh /opt/doorbell/events.db`

## QEMU VM Freezes (macOS HVF)

**Symptom:** VM becomes unresponsive, watchdog restarts it. Host-side watchdog log shows "FAIL" then "RESTART".

**Background:** QEMU's HVF backend on Intel Macs has a known issue where the vCPU thread can occasionally hang under sustained network I/O. This happens roughly once a week with the doorbell workload. The host-side watchdog detects and recovers automatically in ~1.5 minutes.

**This is not the same as the slab memory leak** (see below). If the VM is freezing every 8-28 hours, check the slab.

**Checks:**
1. Check watchdog log: `tail -30 /var/log/doorbell-watchdog.log`
2. If QEMU CPU shows 100%+ at failure, the vCPU is spinning — watchdog recovery is the correct fix
3. If QEMU RSS is normal and load is normal, this is the HVF hang — the watchdog handles it

## Kernel Slab Memory Leak (Alpine Linux)

**Symptom:** VM freezes every 8-28 hours. Inside the VM, `grep Slab /proc/meminfo` shows 300MB+ (should be 50-70MB).

**Cause:** Alpine Linux kernel 6.12's maple tree implementation leaks `maple_node` objects under heavy process churn (ffmpeg spawning every 60 seconds). The slab grows until it exhausts guest RAM, causing swap thrash and a vCPU death spiral.

**Fix:** Migrate to Ubuntu 24.04 (kernel 6.8). See [vm-setup.md](vm-setup.md).

**Verification:** After migration, `grep Slab /proc/meminfo` should show 50-70MB and stay flat over days.

## HVF Idle-Spin (VM at ~100% CPU While Idle)

**Symptom:** QEMU process at ~95% CPU even when idle.

**Cause:** macOS HVF bug with multiple vCPUs.

**Fix:** Use 1 vCPU (`-smp 1` in the QEMU command). This is already the default.

## Useful Commands

```bash
# View app logs
sudo tail -f /var/log/doorbell.log

# Restart the app
sudo systemctl restart doorbell

# Check service status
sudo systemctl status doorbell

# Check memory
free -m

# Check slab health (should be 50-70MB)
grep Slab /proc/meminfo

# Check disk
df -h /

# Deploy updated app (from development machine)
scp src/doorbell.js src/dashboard.html doorbell@<vm-ip>:/opt/doorbell/
ssh doorbell@<vm-ip> 'sudo systemctl restart doorbell'

# Open dashboard
open http://<vm-ip>
```
