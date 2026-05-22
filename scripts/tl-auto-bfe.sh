#!/bin/bash
# Tinglysning auto-backfill med BFE-nummer cursor (ikke OFFSET).
# Kører batch efter batch til alle BFE'er er scannet.
#
# Usage:
#   nohup bash scripts/tl-auto-bfe.sh prod 3200000 > /tmp/tl-auto-bfe-prod.log 2>&1 &

ENV="${1:-prod}"
START_BFE="${2:-100000}"
BATCH_SIZE=100000
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Tinglysning auto-backfill (BFE cursor) ==="
echo "Env: $ENV, Start BFE: $START_BFE"
echo "Started: $(date)"

cd "$PROJECT_DIR" || exit 1

CURRENT_BFE=$START_BFE

while true; do
    LOGFILE="/tmp/tl-auto-bfe-${ENV}-${CURRENT_BFE}.log"
    echo "[$(date)] Starting batch: from-bfe=$CURRENT_BFE → $LOGFILE"

    node scripts/tl-fast.mjs --env="$ENV" --from-bfe="$CURRENT_BFE" --limit="$BATCH_SIZE" > "$LOGFILE" 2>&1
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
        echo "[$(date)] ERROR: exit code $EXIT_CODE — retrying in 5 min"
        sleep 300
        continue
    fi

    if grep -q "Ingen BFE" "$LOGFILE"; then
        echo "[$(date)] DONE — alle BFE'er scannet"
        break
    fi

    # Find last BFE processed from log
    LAST_BFE=$(grep -oP 'startBFE=\K\d+' "$LOGFILE" | tail -1)
    PROCESSED=$(grep -oP 'processed=\K\d+' "$LOGFILE" | tail -1)

    if [ -z "$PROCESSED" ] || [ "$PROCESSED" = "0" ]; then
        echo "[$(date)] No progress — retrying in 2 min"
        sleep 120
        continue
    fi

    # Get the actual last BFE from the batch by looking at the data
    # The script processes LIMIT BFEs starting from CURRENT_BFE
    # Next batch starts from the last BFE in bbr_ejendom_status after CURRENT_BFE + BATCH_SIZE entries
    # We can approximate by using the log
    STATS=$(tail -5 "$LOGFILE" | head -1)
    echo "[$(date)] Batch done: $STATS"

    # Move cursor forward — get next BFE from the DB
    NEXT_BFE=$(node -e "
import https from 'node:https';
import { config } from 'dotenv';
config({ path: '.env.local' });
const REFS = { dev: 'wkzwxfhyfmvglrqtmebw', preview: 'rlkjmqjxmkxuclehbrnl', prod: 'xsyldjqcntiygrtfcszm' };
function runSql(sql) { return new Promise((resolve) => { const body = JSON.stringify({ query: sql }); const timer = setTimeout(() => { resolve({message:'timeout'}); }, 15000); const req = https.request({ hostname: 'api.supabase.com', path: '/v1/projects/' + REFS['$ENV'] + '/database/query', method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.SUPABASE_ACCESS_TOKEN, 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }); req.on('error', () => { clearTimeout(timer); resolve({message:'err'}); }); req.write(body); req.end(); }); }
async function main() {
  const r = await runSql('SELECT bfe_nummer FROM bbr_ejendom_status WHERE bfe_nummer > $CURRENT_BFE ORDER BY bfe_nummer OFFSET $((BATCH_SIZE - 1)) LIMIT 1');
  if (Array.isArray(r) && r.length > 0) { console.log(r[0].bfe_nummer); }
  else { console.log('0'); }
}
main();
" 2>&1)

    if [ "$NEXT_BFE" = "0" ] || [ -z "$NEXT_BFE" ]; then
        echo "[$(date)] DONE — no more BFEs"
        break
    fi

    CURRENT_BFE=$NEXT_BFE
    echo "[$(date)] Next batch from BFE $CURRENT_BFE"
    sleep 30
done

echo "=== Complete === $(date)"
