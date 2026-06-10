#!/usr/bin/env bash
# Stall-resistent runner for BIZZ-1881 TL-backfill (backfill-tl-all-ejf-bfes.mjs).
#
# Baggrund: scriptet er I/O-bundet mod tinglysning.dk og kan ramme zombie-sockets
# (HTTP-timeout på 60s fyrer ikke altid) -> node-event-loop hænger i ep_poll uden
# at fejle. Denne watchdog opdager både (a) proces-død og (b) stall (log vokser
# ikke i STALL_SECS) og genstarter jobbet. offset=833000 matcher den oprindelige
# kørsel; udfyldte BFEer falder automatisk ud af kandidat-sættet, så genstart er
# idempotent (ingen dobbelt-skrivning).
set -u
cd /root/BizzAssist || exit 1

NODE=/usr/bin/node
SCRIPT=scripts/backfill-tl-all-ejf-bfes.mjs
LOG=/tmp/backfill-1881-resumed-20260601-1000.log
OFFSET=833000
CONC=1
STALL_SECS=600     # 10 min uden log-vækst = stall
POLL=60

start() {
  nohup "$NODE" "$SCRIPT" --offset=$OFFSET --concurrency=$CONC >> "$LOG" 2>&1 &
  echo $!
}

PID=""
while true; do
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    echo "[watchdog $(date -Is)] starter backfill (offset=$OFFSET conc=$CONC)" >> "$LOG"
    PID=$(start)
  else
    NOW=$(date +%s); MT=$(stat -c %Y "$LOG" 2>/dev/null || echo "$NOW")
    if [ $(( NOW - MT )) -gt $STALL_SECS ]; then
      echo "[watchdog $(date -Is)] STALL $(( NOW - MT ))s -> dræber $PID og genstarter" >> "$LOG"
      kill -9 "$PID" 2>/dev/null
      sleep 5
      PID=$(start)
    fi
    # Stop watchdog når slice er færdig (scriptet printer 'DONE —')
    if tail -3 "$LOG" 2>/dev/null | grep -q '\[1881-all-ejf\] DONE'; then
      echo "[watchdog $(date -Is)] DONE registreret -> watchdog stopper" >> "$LOG"
      exit 0
    fi
  fi
  sleep $POLL
done
