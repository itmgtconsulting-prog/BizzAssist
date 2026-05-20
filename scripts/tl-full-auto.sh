#!/bin/bash
# Tinglysning full auto-backfill — kører batch efter batch til alt er scannet.
# Uafhængig af Claude-session — kør med nohup.
#
# Usage:
#   nohup bash scripts/tl-full-auto.sh prod 265500 > /tmp/tl-auto-prod.log 2>&1 &
#   nohup bash scripts/tl-full-auto.sh preview 100000 > /tmp/tl-auto-preview.log 2>&1 &
#   nohup bash scripts/tl-full-auto.sh dev 100000 > /tmp/tl-auto-dev.log 2>&1 &

ENV="${1:-prod}"
OFFSET="${2:-0}"
BATCH_SIZE=100000
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Tinglysning auto-backfill ==="
echo "Env: $ENV"
echo "Start offset: $OFFSET"
echo "Batch size: $BATCH_SIZE"
echo "Started: $(date)"
echo ""

cd "$PROJECT_DIR" || exit 1

while true; do
    LOGFILE="/tmp/tl-auto-${ENV}-batch-${OFFSET}.log"
    echo "[$(date)] Starting batch: offset=$OFFSET, limit=$BATCH_SIZE → $LOGFILE"

    node scripts/tl-fast.mjs --env="$ENV" --offset="$OFFSET" --limit="$BATCH_SIZE" > "$LOGFILE" 2>&1
    EXIT_CODE=$?

    # Check result
    if [ $EXIT_CODE -ne 0 ]; then
        echo "[$(date)] ERROR: batch exited with code $EXIT_CODE — retrying in 5 min"
        sleep 300
        continue
    fi

    # Check if "Ingen BFE'er" (no more data)
    if grep -q "Ingen BFE" "$LOGFILE"; then
        echo "[$(date)] DONE — alle BFE'er scannet (offset=$OFFSET)"
        break
    fi

    # Extract stats from last line
    LAST_LINE=$(tail -3 "$LOGFILE" | head -1)
    echo "[$(date)] Batch done: $LAST_LINE"

    # Next batch
    OFFSET=$((OFFSET + BATCH_SIZE))

    # Brief pause between batches (let API cool down)
    echo "[$(date)] Pausing 30s before next batch..."
    sleep 30
done

echo ""
echo "=== Full backfill complete ==="
echo "Finished: $(date)"
