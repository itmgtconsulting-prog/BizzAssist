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

    // BIZZ-2233: DAWA's sekvensnummer er GLOBALT på tværs af alle registre, så
    // et adgangsadresse-hændelsesvindue kan være tomt uden at vi er ajour. Den
    // gamle kode `break`ede på tomt vindue (og på events.length < PAGE_SIZE) →
    // cronen stod permanent stille lige før tusindvis af ægte ændringer i
    // senere vinduer. Vi scanner nu op til `seneste` og springer tomme vinduer
    // over (rykker frem til vinduets top), i stedet for at stoppe.
    let seneste = lastSekvensnummer + MAX_PAGES * EVENT_PAGE_SIZE;
    try {
      const sres = await fetch(`${DAWA_BASE}/replikering/senestesekvensnummer`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (sres.ok) seneste = ((await sres.json()).sekvensnummer as number) ?? seneste;
    } catch {
      logger.warn('[dar-delta] Kunne ikke hente seneste sekvensnummer — bruger bounded scan');
    }

    // Flush-buffer: cursor rykkes KUN frem forbi events hvis tilhørende rækker
    // faktisk er skrevet (safeSeq), så en tidsbudget-afbrydelse midt i et vindue
    // ikke springer uskrevne ændringer over (det var en del af 111-dages-tabet).
    let safeSeq = lastSekvensnummer;
    let pendingRows: DarCacheRow[] = [];
    let pendingDeletes: string[] = [];
    let pendingSeq = lastSekvensnummer;
    const flush = async () => {
      if (pendingRows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .from('cache_dar')
          .upsert(pendingRows, { onConflict: 'adresse_id' });
        if (error) logger.error('[dar-delta] Upsert fejl:', error.message);
        else upserted += pendingRows.length;
        pendingRows = [];
      }
      if (pendingDeletes.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .from('cache_dar')
          .delete()
          .in('adresse_id', pendingDeletes);
        if (error) logger.error('[dar-delta] Delete fejl:', error.message);
        else deleted += pendingDeletes.length;
        pendingDeletes = [];
      }
      safeSeq = pendingSeq;
    };

    let budgetHit = false;
    while (pagesFetched < MAX_PAGES && lastSekvensnummer < seneste && !budgetHit) {
      if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) break;

      const windowTil = Math.min(lastSekvensnummer + EVENT_PAGE_SIZE, seneste);
      let events: Record<string, unknown>[];
      try {
        const res = await fetch(
          `${DAWA_BASE}/replikering/adgangsadresser/haendelser?sekvensnummerfra=${lastSekvensnummer + 1}&sekvensnummertil=${windowTil}`,
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
      pagesFetched++;
      totalEvents += events.length;

      // Behandl events i sekvens-rækkefølge så cursor kan rykkes sikkert frem.
      const ordered = events
        .map((e) => ({
          seq: e.sekvensnummer as number,
          op: e.operation as string,
          id: ((e.data as Record<string, unknown> | undefined)?.id as string) ?? (e.id as string),
        }))
        .filter((e) => e.id)
        .sort((a, b) => a.seq - b.seq);

      for (const e of ordered) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          budgetHit = true;
          break;
        }
        if (e.op === 'delete' || e.op === 'nedlæg') {
          pendingDeletes.push(e.id);
        } else {
          // Gen-hent i mini-struktur (beriget form = samme som backfill).
          const adr = await fetchAdresseMini(e.id);
          if (!adr) {
            skipped++;
          } else {
            const row = buildDarRow(adr);
            if (row) pendingRows.push(row);
          }
        }
        pendingSeq = e.seq;
        if (pendingRows.length + pendingDeletes.length >= UPSERT_BATCH_SIZE) await flush();
      }
      await flush();

      // Fuldt behandlet vindue → ryk forbi hele vinduet (også tomme). Afbrudt
      // af tidsbudget → kun frem til sidst skrevne event (safeSeq).
      lastSekvensnummer = budgetHit ? safeSeq : windowTil;
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
