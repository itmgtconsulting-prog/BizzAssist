#!/bin/bash
# Auto-restart fix-admin-cvr.mjs when it crashes
cd /root/BizzAssist
RUN=1
while true; do
    echo "[$(date)] Starting admin CVR fix (run $RUN)..."
    node scripts/fix-admin-cvr.mjs > /tmp/fix-admin-cvr-auto-${RUN}.log 2>&1
    EXIT=$?
    LAST=$(grep 'updated=' /tmp/fix-admin-cvr-auto-${RUN}.log | tail -1)
    echo "[$(date)] Exited ($EXIT): $LAST"

    # Check if done (all rows have CVR)
    REMAINING=$(node -e "
import pg from 'pg';
import { config } from 'dotenv';
config({ path: '.env.local' });
const c = new pg.Client(process.env.SUPABASE_PROD_DB_URL);
await c.connect();
const r = await c.query(\"SELECT count(*) FROM ejf_administrator WHERE virksomhed_cvr IS NULL AND administrator_type = 'ukendt'\");
console.log(r.rows[0].count);
await c.end();
" 2>&1)
    echo "[$(date)] Remaining ukendt: $REMAINING"

    if [ "$REMAINING" = "0" ] || [ -z "$REMAINING" ]; then
        echo "[$(date)] DONE — all admin rows have CVR or are person-admins"
        break
    fi

    RUN=$((RUN + 1))
    echo "[$(date)] Restarting in 30s..."
    sleep 30
done
