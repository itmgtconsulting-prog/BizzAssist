#!/usr/bin/env bash
# Ugentlig PROD -> PREVIEW (test.bizzassist.dk) data-sync.
#
# Baggrund: der findes ingen automatisk sync fra prod til preview — kun manuelle
# scripts. Dette job sikrer at test mindst 1 gang om ugen får prod-data, så
# backfill-fremdrift (TL, ejerskifte, regnskab m.m.) bliver synlig på test.
#
# Mekanik: scripts/sync-pg-direct.mjs --all er ADDITIVT (ON CONFLICT DO NOTHING,
# og springer en tabel over hvis preview allerede har >= prod). Det er derfor
# idempotent og sikkert at køre gentagne gange — det fylder kun nye rækker på.
#
# flock forhindrer overlap hvis en kørsel trækker ud forbi næste schedule.
# Kører via dev-serverens crontab (samme sted som external-cron-watchdog).
set -u
cd /root/BizzAssist || exit 1

NODE=/usr/bin/node
SCRIPT=scripts/sync-pg-direct.mjs
TS=$(date +%Y%m%d-%H%M)
LOG=/tmp/weekly-prod-to-preview-${TS}.log
LOCK=/tmp/weekly-prod-to-preview.lock

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date -Is)] tidligere sync kører stadig — springer denne over" >> "$LOG"
  exit 0
fi

# Hard timeout: 30 min. If the sync hangs (dead TCP, DB maintenance), kill it
# so the flock is released and doesn't block the next scheduled run.
TIMEOUT=1800

echo "[$(date -Is)] starter PROD -> PREVIEW sync (--all, timeout=${TIMEOUT}s)" >> "$LOG"
timeout --signal=KILL "$TIMEOUT" "$NODE" "$SCRIPT" --from=prod --to=preview --all >> "$LOG" 2>&1
RC=$?
if [ $RC -eq 137 ]; then
  echo "[$(date -Is)] sync KILLED by timeout after ${TIMEOUT}s" >> "$LOG"
else
  echo "[$(date -Is)] sync afsluttet rc=$RC" >> "$LOG"
fi
exit $RC
