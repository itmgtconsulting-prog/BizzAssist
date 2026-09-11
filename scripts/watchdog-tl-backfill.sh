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
DELAY_MS=4000      # BIZZ-1881 2026-09-05: hævet fra 800 → 4000 for ~2x throughput vs.
                   # den ratchet-fastlåste 8000ms-effektive delay (nul 429 i uger). Loftet
                   # MAX_DELAY_MS er stadig default 8000, så 429/timeouts auto-bremser
                   # tilbage til det gamle sikre tempo som sikkerhedsnet.
STALL_SECS=600     # 10 min uden log-vækst = stall. Med hård 45s fetch-timeout i scriptet
                   # logger en sund kørsel hvert ~100-150s; 10 min er rigeligt margin (selv
                   # under 429-backoff) og genopretter 3x hurtigere end de gamle 30 min.
POLL=60

start() {
  nohup "$NODE" "$SCRIPT" --offset=$OFFSET --concurrency=$CONC --delay-ms=$DELAY_MS >> "$LOG" 2>&1 &
  echo $!
}

# ── Self-monitorering (BIZZ-2238) ────────────────────────────────────────────
# Skriv cron_heartbeats-række til PROD så watchdog + service-scan overvåger dette
# lokale backfill: hvis supervisoren dør/hænger, går heartbeatet overdue → alarm.
# Bruger samme SUPABASE_PROD_DB_URL som backfill-scriptet (verificeret virker).
PROD_DB_URL=$(grep -E '^SUPABASE_PROD_DB_URL=' /root/BizzAssist/.env.local 2>/dev/null | cut -d= -f2-)
HB_INTERVAL_MIN=30   # forventet heartbeat-kadence; overdue efter 2× = 60 min
write_heartbeat() {
  # $1=status (success|degraded|error) $2=note $3=expected_interval_min
  [ -z "$PROD_DB_URL" ] && return 0
  local status="$1" note ival
  note=$(printf '%s' "$2" | sed "s/'/''/g")
  ival="${3:-$HB_INTERVAL_MIN}"
  psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -c "
    INSERT INTO public.cron_heartbeats
      (job_name, last_run_at, last_status, expected_interval_minutes, last_degraded_reason)
    VALUES ('tl-backfill-ejf', now(), '$status', $ival,
      $([ "$status" = success ] && echo NULL || echo "'$note'"))
    ON CONFLICT (job_name) DO UPDATE SET
      last_run_at = EXCLUDED.last_run_at, last_status = EXCLUDED.last_status,
      expected_interval_minutes = EXCLUDED.expected_interval_minutes,
      last_degraded_reason = EXCLUDED.last_degraded_reason;
  " >/dev/null 2>&1 || echo "[watchdog $(date -Is)] WARN: heartbeat-skrivning fejlede" >> "$LOG"
}

PID=""
LAST_HB=0
while true; do
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    echo "[watchdog $(date -Is)] starter backfill (offset=$OFFSET conc=$CONC)" >> "$LOG"
    PID=$(start)
  else
    NOW=$(date +%s); MT=$(stat -c %Y "$LOG" 2>/dev/null || echo "$NOW")
    if [ $(( NOW - MT )) -gt $STALL_SECS ]; then
      echo "[watchdog $(date -Is)] STALL $(( NOW - MT ))s -> dræber $PID og genstarter" >> "$LOG"
      write_heartbeat degraded "stall $(( NOW - MT ))s -> genstart"
      kill -9 "$PID" 2>/dev/null
      sleep 5
      PID=$(start)
    fi
    # Stop watchdog når slice er færdig (scriptet printer 'DONE —')
    if tail -3 "$LOG" 2>/dev/null | grep -q '\[1881-all-ejf\] DONE'; then
      echo "[watchdog $(date -Is)] DONE registreret -> watchdog stopper" >> "$LOG"
      # Lang forventet-interval så et FÆRDIGT backfill ikke fejl-alarmerer den
      # kommende uge (tid til at afregistrere det midlertidige job).
      write_heartbeat success "backfill færdig" 10080
      exit 0
    fi
  fi
  # Throttlet sund-heartbeat ~hver HB_INTERVAL_MIN mens jobbet kører.
  NOW=$(date +%s)
  if [ $(( NOW - LAST_HB )) -ge $(( HB_INTERVAL_MIN * 60 )) ]; then
    write_heartbeat success "kører"
    LAST_HB=$NOW
  fi
  sleep $POLL
done
