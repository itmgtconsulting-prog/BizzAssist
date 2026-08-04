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

ok=0
fail=0
for t in "${TABLES[@]}"; do
  echo "── sync public.$t ──"
  start=$(date +%s)
  # Stream prod → test. TRUNCATE + COPY i én transaktion pr. tabel; FK-triggers
  # deaktiveret for load. Hvis pipen fejler, springes tabellen over.
  if psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -c "\copy public.$t TO STDOUT" \
     | psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
         -c "SET session_replication_role = replica;" \
         -c "TRUNCATE public.$t;" \
         -c "\copy public.$t FROM STDIN"; then
    echo "   ✓ $t ($(($(date +%s) - start))s)"
    ok=$((ok + 1))
  else
    echo "   ✗ $t FEJLEDE — springer over"
    fail=$((fail + 1))
  fi
done

echo "── sync færdig: $ok ok, $fail fejlet ──"
# Fejl kun hvis ALT fejlede (delvis sync er stadig nyttig).
[ "$ok" -gt 0 ] || exit 1
