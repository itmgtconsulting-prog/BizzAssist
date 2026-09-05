/**
 * Cron: DAR adresse delta-sync — /api/cron/pull-dar-aendringer
 *
 * BIZZ-1191: Bruger DAWA replikerings-API til at synkronisere nye, ændrede
 * og nedlagte adgangsadresser til cache_dar.
 *
 * DAWA tilbyder et hændelses-API:
 *   /replikering/adgangsadresser/haendelser?sekvensnummerfra=N
 * som returnerer alle ændringer siden et givet sekvensnummer.
 *
 * Gemmer sidst-hentet sekvensnummer i dar_sync_cursor for resumption.
 * DAWA er gratis og uautentificeret — ingen credentials nødvendige.
 *
 * Schedule: 0 5 * * * UTC (dagligt 05:00 — lavprioritets-vindue).
 *
 * @module api/cron/pull-dar-aendringer
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { recordSyncStatus } from '@/app/lib/dataSyncStatus';

export const runtime = 'nodejs';
export const maxDuration = 300;

const DAWA_BASE = 'https://api.dataforsyningen.dk';
const EVENT_PAGE_SIZE = 10000;
const MAX_PAGES = 50;
const UPSERT_BATCH_SIZE = 500;
const SAFETY_MARGIN_MS = 30_000;

/** Verificerer CRON_SECRET */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * cache_dar-row: adresse_id (PK) + raw_data (hele DAWA mini-objektet) +
 * source_hash (sha256 af raw_data) + synced_at. Skal matche det skema
 * backfill-dar-cache.mjs og cachedLookup.ts skriver, så delta-opdaterede
 * rækker har præcis samme form som de backfillede.
 */
interface DarCacheRow {
  adresse_id: string;
  raw_data: Record<string, unknown>;
  source_hash: string;
  synced_at: string;
}

/**
 * Bygger en cache_dar-row fra en DAWA adgangsadresse (struktur=mini).
 *
 * @param adr - DAWA adgangsadresse i mini-struktur
 * @returns Cache row, eller null hvis id mangler
 */
function buildDarRow(adr: Record<string, unknown>): DarCacheRow | null {
  const id = adr.id as string;
  if (!id) return null;

  const rawJson = JSON.stringify(adr);
  return {
    adresse_id: id,
    raw_data: adr,
    source_hash: createHash('sha256').update(rawJson).digest('hex'),
    synced_at: new Date().toISOString(),
  };
}

/**
 * Gen-henter en enkelt adgangsadresse fra DAWA i mini-struktur — den berigede
 * form (vejnavn, postnrnavn, x/y, betegnelse) som consumers læser fra
 * cache_dar.raw_data. Replikerings-hændelsernes rå `data` mangler disse felter,
 * så vi gemmer IKKE hændelses-data direkte (ville give blandet raw_data-form).
 *
 * @param id - DAWA adgangsadresse-UUID
 * @returns Mini-adresseobjekt, eller null ved 404/fejl (nedlagt/ukendt)
 */
async function fetchAdresseMini(id: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${DAWA_BASE}/adgangsadresser/${id}?struktur=mini`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * GET handler — synkroniserer DAR adresser via DAWA replikering.
 *
 * @param request - GET request med CRON_SECRET auth
 * @returns JSON med sync-stats
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor('pull-dar-aendringer', async () => {
    const startTime = Date.now();
    const admin = createAdminClient();

    // 1. Hent sidst-hentet sekvensnummer fra cursor
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cursorData } = await (admin as any)
      .from('dar_sync_cursor')
      .select('sekvensnummer')
      .eq('id', 'default')
      .single();

    let sekvensnummer = (cursorData?.sekvensnummer as number) ?? 0;

    // Hvis ingen cursor, hent seneste sekvensnummer fra DAWA
    if (sekvensnummer === 0) {
      try {
        const seneste = await fetch(`${DAWA_BASE}/replikering/senestesekvensnummer`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (seneste.ok) {
          const data = await seneste.json();
          // Start fra 1000 hændelser før seneste for at fange nylige ændringer
          sekvensnummer = Math.max(0, (data.sekvensnummer as number) - 1000);
        }
      } catch {
        logger.warn('[dar-delta] Kunne ikke hente seneste sekvensnummer');
      }
    }

    logger.log(`[dar-delta] Starter fra sekvensnummer ${sekvensnummer}`);

    // 2. Hent hændelser fra DAWA
    let totalEvents = 0;
    let upserted = 0;
    let deleted = 0;
    let skipped = 0;
    let lastSekvensnummer = sekvensnummer;
    let pagesFetched = 0;

    while (pagesFetched < MAX_PAGES) {
      if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
        logger.warn('[dar-delta] Safety margin ramt');
        break;
      }

      let events: Record<string, unknown>[];
      try {
        const res = await fetch(
          `${DAWA_BASE}/replikering/adgangsadresser/haendelser?sekvensnummerfra=${lastSekvensnummer + 1}&sekvensnummertil=${lastSekvensnummer + EVENT_PAGE_SIZE}`,
          { signal: AbortSignal.timeout(30_000) }
        );
        if (!res.ok) {
          logger.error(`[dar-delta] DAWA HTTP ${res.status}`);
          break;
        }
        events = (await res.json()) as Record<string, unknown>[];
      } catch (err) {
        logger.error('[dar-delta] DAWA fetch error:', err instanceof Error ? err.message : err);
        break;
      }

      if (events.length === 0) break;
      pagesFetched++;
      totalEvents += events.length;

      // Gruppe: ændrede/oprettede adresse-ids (dedup) og nedlagte (delete)
      const changedIds = new Set<string>();
      const deleteIds: string[] = [];

      for (const evt of events) {
        const sekvens = evt.sekvensnummer as number;
        if (sekvens > lastSekvensnummer) lastSekvensnummer = sekvens;

        const operation = evt.operation as string;
        const data = evt.data as Record<string, unknown> | undefined;
        const id = (data?.id as string) ?? (evt.id as string);
        if (!id) continue;

        if (operation === 'delete' || operation === 'nedlæg') {
          deleteIds.push(id);
        } else {
          changedIds.add(id);
        }
      }

      // Gen-hent hver ændret adresse i mini-struktur og byg cache-rows.
      // Vi henter enkeltvis (DAWA-lookup) i stedet for at bruge hændelsens rå
      // data, så raw_data får samme berigede form som backfill/cachedLookup.
      const upsertBatch: DarCacheRow[] = [];
      for (const id of changedIds) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.warn('[dar-delta] Safety margin ramt under gen-hentning');
          break;
        }
        const adr = await fetchAdresseMini(id);
        if (!adr) {
          skipped++;
          continue;
        }
        const row = buildDarRow(adr);
        if (row) upsertBatch.push(row);
      }

      // Batch upsert
      if (upsertBatch.length > 0) {
        for (let i = 0; i < upsertBatch.length; i += UPSERT_BATCH_SIZE) {
          const batch = upsertBatch.slice(i, i + UPSERT_BATCH_SIZE);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error } = await (admin as any)
            .from('cache_dar')
            .upsert(batch, { onConflict: 'adresse_id' });
          if (error) {
            logger.error('[dar-delta] Upsert fejl:', error.message);
          } else {
            upserted += batch.length;
          }
        }
      }

      // Batch delete
      if (deleteIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .from('cache_dar')
          .delete()
          .in('adresse_id', deleteIds);
        if (error) {
          logger.error('[dar-delta] Delete fejl:', error.message);
        } else {
          deleted += deleteIds.length;
        }
      }

      // Færre events end page size = vi er ajour
      if (events.length < EVENT_PAGE_SIZE) break;
    }

    // 3. Opdater cursor
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: cursorErr } = await (admin as any).from('dar_sync_cursor').upsert(
        {
          id: 'default',
          sekvensnummer: lastSekvensnummer,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (cursorErr) {
        logger.error('[dar-delta] Cursor update fejl:', cursorErr.message);
      }
    }

    const durationMs = Date.now() - startTime;
    logger.log(
      `[dar-delta] Done: ${totalEvents} events, ${upserted} upserted, ${deleted} deleted, ${skipped} skipped, ${durationMs}ms`
    );

    await recordSyncStatus('cache_dar', { rowsSynced: upserted, durationMs });

    return {
      response: NextResponse.json({
        ok: true,
        sekvensnummerFrom: sekvensnummer,
        sekvensnummerTo: lastSekvensnummer,
        totalEvents,
        upserted,
        deleted,
        skipped,
        pagesFetched,
        durationMs,
      }),
      // itemsProcessed = events set (0 events på en rolig dag = healthy, ikke
      // degraded — DAR-delta har ofte 0 ændringer). itemsWritten = upserts.
      metrics: { itemsProcessed: totalEvents, itemsWritten: upserted },
    };
  });
}
