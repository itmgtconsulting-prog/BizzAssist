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
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

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

interface DarCacheRow {
  id: string;
  vejnavn: string | null;
  husnr: string | null;
  postnr: string | null;
  postnrnavn: string | null;
  kommunekode: string | null;
  kommunenavn: string | null;
  x: number | null;
  y: number | null;
  status: number | null;
  updated_at: string;
}

/**
 * Mapper en DAWA adgangsadresse til cache_dar row.
 *
 * @param data - DAWA adgangsadresse data
 * @returns Cache row
 */
function mapAdresseToRow(data: Record<string, unknown>): DarCacheRow | null {
  const id = data.id as string;
  if (!id) return null;

  return {
    id,
    vejnavn: (data.vejnavn as string) ?? null,
    husnr: (data.husnr as string) ?? null,
    postnr: ((data.postnr as Record<string, unknown>)?.nr as string) ?? null,
    postnrnavn: ((data.postnr as Record<string, unknown>)?.navn as string) ?? null,
    kommunekode: ((data.kommune as Record<string, unknown>)?.kode as string) ?? null,
    kommunenavn: ((data.kommune as Record<string, unknown>)?.navn as string) ?? null,
    x: (data.adgangspunkt as Record<string, unknown>)?.koordinater
      ? ((data.adgangspunkt as Record<string, unknown>).koordinater as number[])[0]
      : null,
    y: (data.adgangspunkt as Record<string, unknown>)?.koordinater
      ? ((data.adgangspunkt as Record<string, unknown>).koordinater as number[])[1]
      : null,
    status: (data.status as number) ?? null,
    updated_at: new Date().toISOString(),
  };
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

  return withCronMonitor(
    {
      jobName: 'pull-dar-aendringer',
      schedule: '0 5 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
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

        // Gruppe: upserts (oprettet/ændret) og deletes (nedlagt)
        const upsertBatch: DarCacheRow[] = [];
        const deleteIds: string[] = [];

        for (const evt of events) {
          const sekvens = evt.sekvensnummer as number;
          if (sekvens > lastSekvensnummer) lastSekvensnummer = sekvens;

          const operation = evt.operation as string;
          const data = evt.data as Record<string, unknown> | undefined;

          if (operation === 'delete' || operation === 'nedlæg') {
            const id = (data?.id as string) ?? (evt.id as string);
            if (id) deleteIds.push(id);
          } else if (data) {
            const row = mapAdresseToRow(data);
            if (row) upsertBatch.push(row);
          }
        }

        // Batch upsert
        if (upsertBatch.length > 0) {
          for (let i = 0; i < upsertBatch.length; i += UPSERT_BATCH_SIZE) {
            const batch = upsertBatch.slice(i, i + UPSERT_BATCH_SIZE);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error } = await (admin as any)
              .from('cache_dar')
              .upsert(batch, { onConflict: 'id' });
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
          const { error } = await (admin as any).from('cache_dar').delete().in('id', deleteIds);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from('dar_sync_cursor')
        .upsert(
          {
            id: 'default',
            sekvensnummer: lastSekvensnummer,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        )
        .catch((err: Error) => {
          logger.error('[dar-delta] Cursor update fejl:', err.message);
        });

      const durationMs = Date.now() - startTime;
      logger.log(
        `[dar-delta] Done: ${totalEvents} events, ${upserted} upserted, ${deleted} deleted, ${durationMs}ms`
      );

      return NextResponse.json({
        ok: true,
        sekvensnummerFrom: sekvensnummer,
        sekvensnummerTo: lastSekvensnummer,
        totalEvents,
        upserted,
        deleted,
        pagesFetched,
        durationMs,
      });
    }
  );
}
