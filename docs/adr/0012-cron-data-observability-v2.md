# ADR 0012: Cron & Data-Observability v2

**Status:** Accepted
**Dato:** 2026-08-04
**Ticket:** BIZZ-2209

## Kontekst

En sundhedsanalyse (2026-08-04) af de ~40 Vercel-crons afslørede systemiske svagheder, ikke enkeltfejl:

- **"Success" ≠ "gjorde arbejde".** Tre cache-warming crons (`warm-bbr-cache`, `pull-dar-aendringer`, `refresh-vur-cache`) logede `success`-heartbeat dagligt i ~81 dage mens de skrev **0 rækker** — `cache_bbr/dar/vur` frøs 14.–17. maj. Disse caches læses aktivt, så det var reel dataforældelse.
- **Overvågningen var selv i stykker.** Watchdoggens inline `FRESHNESS_CHECKS` brugte kolonnenavne der ikke findes → fejlen blev slugt som "tabel findes måske ikke" → 5/6 friskhedstjek var lydløse no-ops.
- **Konfigurations-drift.** Cron-listen fandtes 4+ steder (vercel.json, hver `withCronMonitor`-config, admin-dashboardets hardcoded liste, den eksterne watchdogs `ALL_CRONS`) + to friskheds-configs (korrekt i `dataFreshness.ts`, forkert i watchdoggen).
- **300s-loft uden mønster.** `refresh-knowledge-cache` timeoutede (504) monolitisk; det mættede 03:00–06:00-vindue fik selv hurtige jobs til at timeoute.
- **Skrøbelig failsafe.** En ekstern watchdog på en manuel server (65.21.2.204, ingen version-styring) sendte falske alarmer og haltede bag git.

## Beslutning

Én sammenhængende observability-stak:

1. **Kanonisk register** (`app/lib/cron/registry.ts`) — `CRON_JOBS` + `DATA_SOURCES` er eneste sandhed. `withCronMonitor`, admin-dashboardet, `dataFreshness.ts` og watchdoggen afleder herfra. En CI-test (`__tests__/unit/cronRegistry.validation.test.ts`) fejler ved drift mellem register ⇔ vercel.json ⇔ route-filer.
2. **Rigere udfald-model** — cron-kald registrerer `success | degraded | error` + arbejds-metrikker (`items_processed/written`). `degraded` = kørte uden exception men lavede intet nyttigt / en afhængighed fejlede. Gemmes på `cron_heartbeats` + tidsserien `cron_run_history` (90 dages retention). Fanger "lydløs no-op".
3. **Fail-loud friskhed** — watchdoggen bruger `checkAllDataFreshness()` (schema-korrekt, registry-drevet). En manglende tabel/kolonne giver nu status `config_error` der eskaleres kritisk via `sendCriticalAlert()` — ikke et lydløst skip.
4. **Durable job-kø** (`public.job_queue` + `process-job-queue`-worker med `FOR UPDATE SKIP LOCKED`) til jobs > 300s. `refresh-knowledge-cache` enqueuer nu ét job pr. topic; workeren bygger dem ét ad gangen (BIZZ-2208).
5. **Scheduler = Vercel + Sentry** — Vercel cron er primær (bevist pålidelig). Sentry Cron Monitors (via `Sentry.withMonitor`) er den uafhængige missed-run-alarm. In-app watchdog dækker email/Sentry-eskalering. Den eksterne watchdog (`scripts/external-cron-watchdog.mjs`) er **nedlagt**.
6. **Fikset de tre knækkede crons** — `warm-bbr-cache` (nedlagt DAWA `/bfe` → fælles `bfeAdresse.ts`-resolver), `pull-dar-aendringer` (manglende `dar_sync_cursor`-tabel oprettet), `refresh-vur-cache` (direkte Basic-auth → `proxyUrl` + OAuth Bearer, som `/api/vurdering`).

## Åbne beslutninger

- **Ekstern-server-oprydning (manuel):** crontab-entryet på 65.21.2.204 skal fjernes (`crontab -e`, slet `external-cron-watchdog.mjs`-linjen). Kan ikke gøres via kode — kræver SSH-adgang.
- **`recordSyncStatus`-udbredelse:** foreløbig wired i de tre fiksede crons; øvrige data-producerende crons kan adoptere den inkrementelt (friskhed dækkes allerede direkte af `checkAllDataFreshness`).
- **`refresh-vur-cache` kandidat-udvælgelse** læser stadig kun stale rækker fra `cache_vur` selv (tilføjer ikke nye BFE'er) — separat forbedring hvis fuld VUR-dækning ønskes.

## Konsekvenser

**Positive:**

- En silently no-op'ende cron fanges nu automatisk (degraded) i stedet for at rådne i måneder.
- Fejl-konfigureret overvågning fejler i CI/kritisk alarm, ikke lydløst.
- Tunge jobs kører uden at ramme 300s-loftet.
- Én kilde til cron/datakilde-sandhed — ingen drift.
- Fjernet afhængighed af en manuel, driftende server.

**Negative:**

- `cron_run_history` vokser (afbødet af 90-dages purge-cron).
- To ekstra crons (`process-job-queue` hver 5. min, `purge-cron-history` dagligt) → 42 crons i alt (under Vercels 100-grænse).
- `withCronMonitor` accepterer nu både jobName-string og legacy-config; de resterende ~35 crons kører fortsat på legacy-config-formen (fungerer, men bør migreres inkrementelt til string-formen).

## Relaterede filer

- `app/lib/cron/registry.ts` — kanonisk register (nyt)
- `app/lib/cronMonitor.ts` / `app/lib/cronHeartbeat.ts` — udfald-model v2
- `app/lib/dataFreshness.ts` / `app/lib/dataSyncStatus.ts` — friskheds-konsolidering
- `app/lib/jobQueue.ts` / `app/lib/jobHandlers.ts` / `app/api/cron/process-job-queue/route.ts` — durable kø
- `app/api/cron/watchdog/route.ts` — registry-drevet friskhed + config_error-eskalering
- `app/api/admin/cron-status/route.ts` + `CronStatusClient.tsx` — dashboard v2
- `supabase/migrations/192_cron_observability.sql` — skema
