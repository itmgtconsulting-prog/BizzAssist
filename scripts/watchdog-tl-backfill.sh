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
OFFSET=0           # BIZZ-1881: probede BFEer falder nu ud af kandidat-sættet
                   # (tinglysning_backfill_probed), så vi starter altid fra laveste
                   # u-probede BFE i stedet for at springe et fast antal over.
CONC=1
DELAY_MS=800       # langsom start; scriptet hæver selv ved 429
STALL_SECS=600     # 10 min uden log-vækst = stall. Med hård 45s fetch-timeout i scriptet
                   # logger en sund kørsel hvert ~100-150s; 10 min er rigeligt margin (selv
                   # under 429-backoff) og genopretter 3x hurtigere end de gamle 30 min.
POLL=60

start() {
  nohup "$NODE" "$SCRIPT" --offset=$OFFSET --concurrency=$CONC --delay-ms=$DELAY_MS >> "$LOG" 2>&1 &
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
