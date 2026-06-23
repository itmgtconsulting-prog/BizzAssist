#!/usr/bin/env bash
# Ensures the TL-backfill watchdog is running. Called from crontab every 5 min.
# If the watchdog (watchdog-tl-backfill.sh) is already running, this is a no-op.
# If not, it starts the watchdog as a detached process.
set -u

WATCHDOG=/root/BizzAssist/scripts/watchdog-tl-backfill.sh
LOG=/tmp/backfill-watchdog-ensure.log

if pgrep -f "watchdog-tl-backfill.sh" >/dev/null 2>&1; then
  exit 0
fi

echo "[$(date -Is)] watchdog not running — starting" >> "$LOG"
setsid nohup /usr/bin/bash "$WATCHDOG" </dev/null >>/dev/null 2>&1 &
echo "[$(date -Is)] started PID $!" >> "$LOG"
