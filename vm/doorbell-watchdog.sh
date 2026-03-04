#!/bin/bash
# Doorbell VM watchdog — runs on Mac host as a LaunchDaemon
# Checks if the doorbell service is responsive, restarts QEMU if not.
# Install: sudo cp vm/doorbell-watchdog.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/doorbell-watchdog.sh

LOG=/var/log/doorbell-watchdog.log
PLIST=/Library/LaunchDaemons/com.doorbell.qemu.plist
CHECK_URL="http://192.168.1.7/api/status"
FAIL_THRESHOLD=3  # consecutive failures before restart
INTERVAL=60       # seconds between checks

fail_count=0

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"
}

restart_vm() {
    log "RESTART — bouncing QEMU VM"
    launchctl bootout system/com.doorbell.qemu 2>/dev/null
    sleep 5
    launchctl bootstrap system "$PLIST" 2>/dev/null
    log "RESTART — QEMU VM restarted, waiting 60s for boot"
    sleep 60
    fail_count=0
}

log "Watchdog started (threshold=${FAIL_THRESHOLD}, interval=${INTERVAL}s)"

while true; do
    # Quick HTTP check with 5s timeout
    if curl -sf --max-time 5 "$CHECK_URL" >/dev/null 2>&1; then
        if [ $fail_count -gt 0 ]; then
            log "OK — recovered after ${fail_count} failure(s)"
        fi
        fail_count=0
    else
        fail_count=$((fail_count + 1))
        log "FAIL ${fail_count}/${FAIL_THRESHOLD} — no response from ${CHECK_URL}"

        if [ $fail_count -ge $FAIL_THRESHOLD ]; then
            restart_vm
        fi
    fi

    sleep "$INTERVAL"
done
