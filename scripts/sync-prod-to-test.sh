#!/usr/bin/env bash
#
# BIZZ-2210: Prod → Test data-sync.
#
# Vercel-crons kører KUN på prod, så test.bizzassist.dk får aldrig friske data
# fra sync-crons. Dette script kopierer et sæt nøgletabeller prod → test via
# streaming psql \COPY (ingen disk, håndterer millioner af rækker). Kaldes af
# .github/workflows/sync-test-data.yml på en ugentlig schedule.
#
# Kræver env:
#   PROD_DB_URL  — postgresql://...@db.<prod-ref>.supabase.co:5432/postgres
#   TEST_DB_URL  — postgresql://...@db.<test-ref>.supabase.co:5432/postgres
#
# Sikkerhed: pr. tabel TRUNCATE + streaming COPY inde i én transaktion med
# session_replication_role=replica (springer FK-triggers over under load).
# En fejl på én tabel stopper ikke de øvrige (best-effort refresh).
#
set -uo pipefail

# Nøgletabeller test har brug for til QA. Selvstændige/cache-tunge tabeller —
# rækkefølge er ligegyldig da FK-checks er slået fra under load.
TABLES=(
  cvr_virksomhed
  cvr_deltager
  ejf_ejerskab
  bbr_ejendom_status
  cache_bbr
  cache_cvr
  cache_dar
  cache_vur
)

: "${PROD_DB_URL:?PROD_DB_URL mangler}"
: "${TEST_DB_URL:?TEST_DB_URL mangler}"

# Kritiske tabeller = de frosne caches der ER problemet. Fejler én af dem, er
# sync'en degraderet (test-cache forbliver stale). Core-tabeller (cvr/ejf/
# bbr_status) må gerne springes over pga. FK/skema-drift uden at alarmere.
CRITICAL="cache_bbr cache_cvr cache_dar cache_vur"

run_started=$(date +%s)
ok=0
fail=0
failed_list=""
critical_failed=0
for t in "${TABLES[@]}"; do
  echo "── sync public.$t ──"
  start=$(date +%s)
  # Stream prod → test. TRUNCATE + COPY i én transaktion pr. tabel; FK-triggers
  # deaktiveret for load. statement_timeout=0 så store tabeller (millioner
  # rækker) ikke dræbes af DB'ens default-timeout. FK-refererede tabeller fejler
  # på TRUNCATE og springes sikkert over (ingen CASCADE — undgår util. data-tab
  # på test). Skema-drift-tabeller springes ligeledes over.
  # statement_timeout=0 sættes via PGOPTIONS (IKKE -c "SET ...", da SET-output
  # ellers forurener den pipede COPY-stdout og får hver tabel til at fejle).
  if PGOPTIONS='-c statement_timeout=0' psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 \
         -c "\copy public.$t TO STDOUT" \
     | PGOPTIONS='-c statement_timeout=0' psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
         -c "SET session_replication_role = replica;" \
         -c "TRUNCATE public.$t;" \
         -c "\copy public.$t FROM STDIN"; then
    echo "   ✓ $t ($(($(date +%s) - start))s)"
    ok=$((ok + 1))
  else
    echo "   ✗ $t FEJLEDE — springer over"
    fail=$((fail + 1))
    failed_list="$failed_list $t"
    case " $CRITICAL " in *" $t "*) critical_failed=1 ;; esac
  fi
done

echo "── sync færdig: $ok ok, $fail fejlet ──"

# ── Self-monitorering (BIZZ-2210) ────────────────────────────────────────────
# Skriv en heartbeat til PROD's cron_heartbeats, så den EKSISTERENDE watchdog
# overvåger sync'en: alarmerer hvis den fejler, degraderer, eller holder op med
# at køre (overdue > 2× uge). Uden dette ville en delvis fejl gå lydløst.
if [ "$ok" -eq 0 ]; then
  status="error"
elif [ "$critical_failed" -eq 1 ]; then
  status="degraded"
else
  status="success"
fi
dur_ms=$(((($(date +%s) - run_started)) * 1000))
note=$(printf '%s' "${failed_list# }" | sed "s/'/''/g")
psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.cron_heartbeats
    (job_name, last_run_at, last_status, last_duration_ms, expected_interval_minutes,
     last_error, last_items_processed, last_items_written, last_degraded_reason)
  VALUES ('sync-prod-to-test', now(), '$status', $dur_ms, 10080,
     $([ -n "$note" ] && echo "'fejlede: $note'" || echo NULL),
     $((ok + fail)), $ok,
     $([ "$status" = degraded ] && echo "'kritisk cache-tabel sprang over: $note'" || echo NULL))
  ON CONFLICT (job_name) DO UPDATE SET
     last_run_at = EXCLUDED.last_run_at, last_status = EXCLUDED.last_status,
     last_duration_ms = EXCLUDED.last_duration_ms,
     expected_interval_minutes = EXCLUDED.expected_interval_minutes,
     last_error = EXCLUDED.last_error, last_items_processed = EXCLUDED.last_items_processed,
     last_items_written = EXCLUDED.last_items_written,
     last_degraded_reason = EXCLUDED.last_degraded_reason;
" && echo "heartbeat skrevet: status=$status" || echo "WARN: heartbeat-skrivning fejlede"

# Exit non-zero (→ GitHub-fejlmail) hvis intet synkede eller en kritisk cache fejlede.
[ "$status" = "error" ] && exit 1
[ "$critical_failed" -eq 1 ] && exit 1
exit 0
