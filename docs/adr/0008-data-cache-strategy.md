# ADR 0008: Lokal Data-Cache Strategi

**Status:** Accepted  
**Dato:** 2026-04-26  
**Ticket:** BIZZ-911

## Kontekst

BizzAssist henter data fra 6+ eksterne API'er (Datafordeler BBR/VUR/EJF, CVR ES, DAWA/DAR, Vurderingsportalen) ved hvert sideopslag. Dette giver:

- 1-3 sekunders svartider per API-kald
- Rate-limit risiko ved mange samtidige brugere
- Umulige krydsanalyser (fx "find alle ejendomme ejet af branche X")
- AI-features begrænset til single-entity lookup

## Beslutning

### Cache-strategi: Cache-first med live-fallback

**Pattern:** `cachedLookup.ts` implementerer generisk cache-first lookup:

1. Tjek lokal Supabase cache-tabel
2. Hvis hit og frisk (< staleness threshold) → returner cached data
3. Hvis miss eller stale → kald live API → upsert til cache → returner

**Staleness thresholds:**
| Kilde | Threshold | Begrundelse |
|-------|-----------|-------------|
| BBR | 7 dage | Bygningsdata ændres sjældent |
| CVR | 1 dag | Virksomhedsdata kan ændre sig dagligt |
| DAR | 30 dage | Adresser er meget stabile |
| VUR | 30 dage | Vurderinger opdateres årligt |

### Cache-tabeller (Migration 082)

| Tabel            | Nøgle       | Indhold                     | Est. størrelse |
| ---------------- | ----------- | --------------------------- | -------------- |
| cache_bbr        | bfe_nummer  | Bygninger + enheder (JSONB) | ~13 GB         |
| cache_cvr        | cvr_nummer  | Virksomhedsdata (JSONB)     | ~5 GB          |
| cache_dar        | adresse_id  | Adgangsadresser (JSONB)     | ~8 GB          |
| cache_vur        | bfe_nummer  | Vurderinger (JSONB)         | ~9 GB          |
| data_sync_status | source_name | Sync-monitorering           | ~1 KB          |

**Total estimat:** ~35 GB

### Sync-strategi

**Initial backfill:** Batch-scripts (scripts/backfill-\*-cache.mjs) med throttling.
**Inkrementel sync:** Eksisterende cron-jobs (pull-bbr-events, pull-cvr-aendringer) udvides til at opdatere cache.
**Opportunistisk caching:** Live API-svar upsert'es til cache ved cache miss.

### Monitorering

- `data_sync_status` tabel med last_sync_at, rows_synced, last_error
- `/api/admin/sync-status` endpoint med health-check (ok/stale/missing)
- Daily-status email inkluderer cache freshness

## Åbne beslutninger

- **BIZZ-921:** Database-hosting (Supabase Team $599/md vs. dedikeret PostgreSQL)
- **BIZZ-922:** Datafordeler bulk-download vilkår
- **BIZZ-923:** GDPR-behandlingsgrundlag for persondata i cache

## Konsekvenser

**Positive:**

- Svartider < 100ms for cached data
- Krydsanalyser mulige via SQL
- AI kan bruge komplet datasæt
- Reducer ekstern API-belastning 80%+

**Negative:**

- ~35 GB ekstra storage
- Stale data risiko (mitigeret af fallback + thresholds)
- GDPR-ansvar for cached persondata
- Initial backfill tager 24-48 timer

## Relaterede filer

- `app/lib/cachedLookup.ts` — cache-first utility
- `supabase/migrations/082_data_cache_infrastructure.sql` — schema
- `scripts/backfill-bbr-cache.mjs` — BBR backfill
- `scripts/backfill-cvr-cache.mjs` — CVR backfill
- `scripts/backfill-dar-cache.mjs` — DAR backfill
- `scripts/backfill-vur-cache.mjs` — VUR backfill
- `app/api/admin/sync-status/route.ts` — monitoring API
