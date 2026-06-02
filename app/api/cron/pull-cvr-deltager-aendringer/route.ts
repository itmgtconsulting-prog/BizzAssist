/**
 * Cron: CVR deltager delta-sync — /api/cron/pull-cvr-deltager-aendringer
 *
 * BIZZ-1187: Dagligt vindue på CVR ES deltager-index. Henter deltagere
 * (personer/virksomheder) og upsert'er til cvr_deltager + cvr_deltagerrelation.
 *
 * BIZZ-1976: Skiftet fra FAST 5-dages rullende vindue (now-5d) til PERSISTENT
 * watermark på CVR-feltet `sidstIndlaest` (feed-ankomst, monotont stigende ift.
 * vores forbrug). Genoptager fra (gemt watermark − safety-overlap), så cron-
 * nedetid > vindue ikke længere taber delta permanent (jf. BIZZ-1954/1975: 14
 * dages tabt delta da DB stoppede). Watermark gemmes pr. kørsel i sync_state
 * (source='cvr_deltager') og må kun rykke fremad (shouldAdvanceWatermark).
 * windowDays bevares som bootstrap-fallback ved manglende watermark.
 *
 * Samme pattern som pull-cvr-aendringer (BIZZ-651) — search_after pagination,
 * idempotent upsert, safety margin.
 *
 * Schedule: 45 3 * * * UTC (dagligt 03:45 — 15 min efter CVR virksomhed-delta).
 *
 * @module api/cron/pull-cvr-deltager-aendringer
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import {
  DEFAULT_OVERLAP_MINUTES,
  computeSyncFrom,
  maxIso,
  shouldAdvanceWatermark,
} from '@/app/lib/syncWatermark';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** sync_state-kilde-identifikator for denne inkrementelle sync */
const SYNC_SOURCE = 'cvr_deltager';

/** Default bootstrap-vindue (dage) når der ikke findes et gemt watermark */
const DEFAULT_WINDOW_DAYS = 5;

/** ES batch-size */
const ES_PAGE_SIZE = 500;

/** Safety cap på ES-batches. BIZZ-1976: hævet fra 200 → 800 (op til 400k
 *  docs/kørsel) så travle feed-dage (~180k/dag) og watermark-backlog kan
 *  drænes i én kørsel. Den reelle grænse er tidsbudgettet (SAFETY_MARGIN_MS
 *  før maxDuration), så et højere sidetal udnytter blot hele 5-min-vinduet. */
const MAX_ES_PAGES = 800;

/** Supabase upsert-batch */
const UPSERT_BATCH_SIZE = 200;

/** Safety-margin før Vercel maxDuration */
const SAFETY_MARGIN_MS = 30_000;

/** CVR ES base URL */
const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Verificerer CRON_SECRET + (i prod) Vercel cron-header.
 *
 * @param request - Incoming request
 * @returns True hvis auth OK
 */
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
 * Returnerer Basic auth header til CVR ES.
 *
 * @returns Auth header string eller null
 */
function getCvrEsAuthHeader(): string | null {
  const user = process.env.CVR_ES_USER;
  const pass = process.env.CVR_ES_PASS;
  if (!user || !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// ─── Deltager mapping ────────────────────────────────────────────────────────

/** Finder gældende (åben) periode i et tidsbestemt array */
function gyldigNu(arr: Record<string, unknown>[]): Record<string, unknown> | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const periode = (x: Record<string, unknown>) =>
    (x.periode as Record<string, unknown> | undefined) ?? {};
  return arr.find((x) => periode(x).gyldigTil == null) ?? arr[arr.length - 1];
}

/** Normaliserer rollenavn fra CVR FUNKTION-attribut */
function normalizeRolle(raw: string): string | null {
  if (!raw) return null;
  const low = raw.toLowerCase();
  if (low.includes('direktør') || low.includes('adm.')) return 'direktør';
  if (low.includes('bestyrelsesmedlem')) return 'bestyrelsesmedlem';
  if (low.includes('formand')) return 'formand';
  if (low.includes('stifter')) return 'stifter';
  if (low.includes('reel ejer') || low.includes('reel_ejer')) return 'reel_ejer';
  if (low === 'ejer' || low.includes('fuldt ansvarlig')) return 'ejer';
  if (low.includes('suppleant')) return 'suppleant';
  return low.slice(0, 50);
}

interface DeltagerRow {
  enhedsnummer: number;
  navn: string;
  adresse_json: unknown;
  roller_json: unknown;
  sidst_opdateret: string | null;
  sidst_indlaest: string | null;
  sidst_hentet_fra_cvr: string;
}

interface RelationRow {
  virksomhed_cvr: string;
  deltager_enhedsnummer: number;
  type: string;
  ejerandel_pct: number | null;
  gyldig_fra: string;
  gyldig_til: string | null;
  sidst_opdateret: string | null;
  sidst_hentet_fra_cvr: string;
}

/**
 * Mapper et CVR ES deltager-hit til cvr_deltager + cvr_deltagerrelation rows.
 *
 * @param hit - ES search hit
 * @returns Deltager + relationer, eller null ved ugyldige data
 */
function mapDeltagerHit(hit: Record<string, unknown>): {
  deltager: DeltagerRow;
  relationer: RelationRow[];
} | null {
  const src = hit._source as Record<string, unknown> | undefined;
  const del =
    (src?.Vrdeltagerperson as Record<string, unknown>) ??
    (src?.VrDeltager as Record<string, unknown>);
  if (!del) return null;

  const enhedsNummer = del.enhedsNummer as number | undefined;
  if (!enhedsNummer) return null;

  const navne = Array.isArray(del.navne) ? del.navne : [];
  const aktivtNavn = gyldigNu(navne as Record<string, unknown>[]);
  const navn = (aktivtNavn?.navn as string) ?? '';
  if (!navn) return null;

  const adresser = Array.isArray(del.beliggenhedsadresse) ? del.beliggenhedsadresse : [];
  const adresse = gyldigNu(adresser as Record<string, unknown>[]);

  const relationer: RelationRow[] = [];
  const rels = Array.isArray(del.virksomhedSummariskRelation)
    ? del.virksomhedSummariskRelation
    : [];

  for (const rel of rels as Record<string, unknown>[]) {
    const virk = rel.virksomhed as Record<string, unknown> | undefined;
    if (!virk) continue;
    const cvr = virk.cvrNummer as number | undefined;
    if (!cvr) continue;

    const orgs = Array.isArray(rel.organisationer) ? rel.organisationer : [];
    for (const org of orgs as Record<string, unknown>[]) {
      const hovedtype = (org.hovedtype as string) ?? '';
      const medlemsData = Array.isArray(org.medlemsData) ? org.medlemsData : [];

      for (const md of medlemsData as Record<string, unknown>[]) {
        const attrs = Array.isArray(md.attributter) ? md.attributter : [];

        let ejerandelPct: number | null = null;
        // BIZZ-1966: reel CVR-offentliggørelsesdato for ejerandel-perioden,
        // bruges som sidst_opdateret (INDRAPPORTERET) på register-rækker i
        // stedet for deltager-niveau del.sidstOpdateret.
        let ejerandelSidstOpdateret: string | null = null;
        const ejerAttr = (attrs as Record<string, unknown>[]).find(
          (a) => a.type === 'EJERANDEL' || a.type === 'EJERANDEL_PROCENT'
        );
        if (ejerAttr) {
          const ejerVals = Array.isArray((ejerAttr as Record<string, unknown>).vaerdier)
            ? ((ejerAttr as Record<string, unknown>).vaerdier as Record<string, unknown>[])
            : [];
          const gyldigEjer =
            ejerVals.find((v) => !(v.periode as Record<string, unknown> | undefined)?.gyldigTil) ??
            ejerVals[ejerVals.length - 1];
          if (gyldigEjer?.vaerdi) {
            const raw = parseFloat(gyldigEjer.vaerdi as string);
            ejerandelPct = raw <= 1 ? raw * 100 : raw;
            ejerandelSidstOpdateret = (gyldigEjer.sidstOpdateret as string) ?? null;
          }
        }

        for (const attr of attrs as Record<string, unknown>[]) {
          if (attr.type !== 'FUNKTION') continue;
          const vaerdier = Array.isArray(attr.vaerdier)
            ? (attr.vaerdier as Record<string, unknown>[])
            : [];
          for (const v of vaerdier) {
            const rolleRaw = v.vaerdi as string;
            if (!rolleRaw) continue;
            const rolle = normalizeRolle(rolleRaw);
            if (!rolle) continue;

            const periodeObj = v.periode as Record<string, unknown> | undefined;
            const gyldigFra =
              ((periodeObj?.gyldigFra as string) ?? '').slice(0, 10) || '1900-01-01';
            relationer.push({
              virksomhed_cvr: String(cvr),
              deltager_enhedsnummer: enhedsNummer,
              type: rolle,
              ejerandel_pct: rolle === 'register' ? ejerandelPct : null,
              gyldig_fra: gyldigFra,
              gyldig_til: ((periodeObj?.gyldigTil as string) ?? '').slice(0, 10) || null,
              // BIZZ-1966: reel CVR-offentliggørelsesdato pr. periode (register =
              // ejerandel-værdiens dato, øvrige roller = FUNKTION-værdiens dato),
              // ikke deltager-niveau del.sidstOpdateret (ét nyligt tidsstempel).
              sidst_opdateret:
                (rolle === 'register' ? ejerandelSidstOpdateret : null) ??
                (v.sidstOpdateret as string) ??
                null,
              sidst_hentet_fra_cvr: new Date().toISOString(),
            });
          }
        }
      }

      // Fallback: brug hovedtype som rolle
      if (relationer.filter((r) => r.virksomhed_cvr === String(cvr)).length === 0 && hovedtype) {
        const fallbackType = normalizeRolle(hovedtype) ?? hovedtype.toLowerCase().slice(0, 50);
        relationer.push({
          virksomhed_cvr: String(cvr),
          deltager_enhedsnummer: enhedsNummer,
          type: fallbackType,
          ejerandel_pct: null,
          gyldig_fra: '1900-01-01',
          gyldig_til: null,
          // BIZZ-1966: fallback uden pr-værdi-periode har ingen reel
          // offentliggørelsesdato i kilden → null (vises som '—').
          sidst_opdateret: null,
          sidst_hentet_fra_cvr: new Date().toISOString(),
        });
      }
    }
  }

  return {
    deltager: {
      enhedsnummer: enhedsNummer,
      navn,
      adresse_json: adresse ?? null,
      roller_json:
        relationer.length > 0
          ? relationer.map((r) => ({
              cvr: r.virksomhed_cvr,
              type: r.type,
              fra: r.gyldig_fra,
              til: r.gyldig_til,
            }))
          : null,
      sidst_opdateret: (del.sidstOpdateret as string) ?? null,
      sidst_indlaest: (del.sidstIndlaest as string) ?? null,
      sidst_hentet_fra_cvr: new Date().toISOString(),
    },
    relationer,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * GET handler — kører CVR deltager delta-sync.
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
      jobName: 'pull-cvr-deltager-aendringer',
      schedule: '45 3 * * *',
      intervalMinutes: 24 * 60,
      maxRuntimeMinutes: 5,
    },
    async () => {
      const startTime = Date.now();
      const auth = getCvrEsAuthHeader();
      if (!auth) {
        return NextResponse.json(
          { ok: false, error: 'CVR_ES_USER/PASS ikke konfigureret' },
          { status: 503 }
        );
      }

      const windowDaysRaw = request.nextUrl.searchParams.get('windowDays');
      const maxPagesRaw = request.nextUrl.searchParams.get('maxPages');
      const overlapRaw = request.nextUrl.searchParams.get('overlapMinutes');
      const windowDays = windowDaysRaw ? parseInt(windowDaysRaw, 10) : DEFAULT_WINDOW_DAYS;
      const maxPages = maxPagesRaw ? parseInt(maxPagesRaw, 10) : MAX_ES_PAGES;
      const overlapMinutes = overlapRaw ? parseInt(overlapRaw, 10) : DEFAULT_OVERLAP_MINUTES;

      const admin = createAdminClient();

      // BIZZ-1976: Læs persistent watermark. from = (watermark − overlap), eller
      // bootstrap-fallback (now − windowDays) ved manglende/ugyldigt watermark.
      let storedWatermark: string | null = null;
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: ss, error: ssErr } = await (admin as any)
          .from('sync_state')
          .select('last_watermark')
          .eq('source', SYNC_SOURCE)
          .maybeSingle();
        if (ssErr) {
          logger.warn(`[deltager-delta] sync_state read fejl: ${ssErr.message} — bruger fallback`);
        } else {
          storedWatermark = (ss?.last_watermark as string) ?? null;
        }
      }

      const now = new Date();
      const fromDate = computeSyncFrom(storedWatermark, windowDays, overlapMinutes, now);

      logger.log(
        `[deltager-delta] Starter: watermark=${storedWatermark ?? 'INGEN'} → from=${fromDate} ` +
          `(overlap ${overlapMinutes}m, bootstrap ${windowDays}d)`
      );

      // 1. Fetch deltager-ændringer fra CVR ES
      const allDeltagere: DeltagerRow[] = [];
      const allRelationer: RelationRow[] = [];
      // BIZZ-1976: akkumulér MAX(sidstIndlaest) på tværs af alle sider →
      // næste watermark-kandidat.
      let maxSidstIndlaest: string | null = null;
      let searchAfter: unknown[] | null = null;
      let pagesFetched = 0;
      let esError: string | null = null;

      while (pagesFetched < maxPages) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.warn('[deltager-delta] Safety margin ramt — stopper ES fetch');
          break;
        }

        const body: Record<string, unknown> = {
          _source: [
            'Vrdeltagerperson.enhedsNummer',
            'Vrdeltagerperson.navne',
            'Vrdeltagerperson.beliggenhedsadresse',
            'Vrdeltagerperson.virksomhedSummariskRelation',
            'Vrdeltagerperson.sidstOpdateret',
            'Vrdeltagerperson.sidstIndlaest',
          ],
          size: ES_PAGE_SIZE,
          // BIZZ-1976: sortér/filtrér på sidstIndlaest (feed-ankomst) i stedet
          // for sidstOpdateret — fanger også genudgivelser/korrektioner hvor
          // sidstOpdateret ikke flytter sig.
          sort: [
            { 'Vrdeltagerperson.sidstIndlaest': 'asc' },
            { 'Vrdeltagerperson.enhedsNummer': 'asc' },
          ],
          query: {
            range: {
              'Vrdeltagerperson.sidstIndlaest': { gte: fromDate },
            },
          },
        };
        if (searchAfter) body.search_after = searchAfter;

        try {
          const res = await fetch(`${CVR_ES_BASE}/deltager/_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            esError = `CVR ES HTTP ${res.status}`;
            break;
          }
          const json = (await res.json()) as {
            hits?: { hits?: Array<{ _source?: unknown; sort?: unknown[] }> };
          };
          const hits = (json.hits?.hits ?? []) as Record<string, unknown>[];
          if (hits.length === 0) break;

          for (const hit of hits) {
            const mapped = mapDeltagerHit(hit);
            if (mapped) {
              allDeltagere.push(mapped.deltager);
              allRelationer.push(...mapped.relationer);
              // BIZZ-1976: ryk watermark-kandidat frem til seneste feed-ankomst.
              maxSidstIndlaest = maxIso(maxSidstIndlaest, mapped.deltager.sidst_indlaest);
            }
          }
          pagesFetched++;

          const last = hits[hits.length - 1];
          if (!last.sort || hits.length < ES_PAGE_SIZE) break;
          searchAfter = last.sort as unknown[];
        } catch (err) {
          esError = err instanceof Error ? err.message : 'CVR ES fetch exception';
          break;
        }
      }

      if (esError && allDeltagere.length === 0) {
        return NextResponse.json(
          { ok: false, error: esError, windowDays, fromDate },
          { status: 502 }
        );
      }

      logger.log(
        `[deltager-delta] Hentet ${allDeltagere.length} deltagere, ${allRelationer.length} relationer over ${pagesFetched} sider`
      );

      // 2. Batch upsert til Supabase
      let deltagerUpserted = 0;
      let relationerUpserted = 0;

      // Upsert deltagere
      for (let i = 0; i < allDeltagere.length; i += UPSERT_BATCH_SIZE) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.warn('[deltager-delta] Safety margin ramt — stopper upsert');
          break;
        }
        const batch = allDeltagere.slice(i, i + UPSERT_BATCH_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .from('cvr_deltager')
          .upsert(batch, { onConflict: 'enhedsnummer', ignoreDuplicates: false });
        if (error) {
          logger.error('[deltager-delta] cvr_deltager upsert fejl:', error.message);
        } else {
          deltagerUpserted += batch.length;
        }
      }

      // Upsert relationer
      for (let i = 0; i < allRelationer.length; i += UPSERT_BATCH_SIZE) {
        if (Date.now() - startTime > maxDuration * 1000 - SAFETY_MARGIN_MS) {
          logger.warn('[deltager-delta] Safety margin ramt — stopper relation upsert');
          break;
        }
        const batch = allRelationer.slice(i, i + UPSERT_BATCH_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any).from('cvr_deltagerrelation').upsert(batch, {
          onConflict: 'virksomhed_cvr,deltager_enhedsnummer,type,gyldig_fra',
          ignoreDuplicates: false,
        });
        if (error) {
          logger.error('[deltager-delta] cvr_deltagerrelation upsert fejl:', error.message);
        } else {
          relationerUpserted += batch.length;
        }
      }

      // 3. BIZZ-1976: Persistér watermark — KUN fremad og KUN ved fejlfri kørsel.
      // Et esError (partiel/afbrudt fetch) eller upsert-fejl må ikke rykke
      // watermark, ellers tabes ufuldstændigt hentet delta permanent.
      const cleanRun = !esError;
      const advance = cleanRun && shouldAdvanceWatermark(storedWatermark, maxSidstIndlaest);
      let watermarkSaved: string | null = null;
      if (advance) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: wmErr } = await (admin as any).from('sync_state').upsert(
          {
            source: SYNC_SOURCE,
            last_watermark: maxSidstIndlaest,
            last_run_at: new Date().toISOString(),
            last_run_count: deltagerUpserted,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'source' }
        );
        if (wmErr) {
          logger.error(`[deltager-delta] watermark-gem fejl: ${wmErr.message}`);
        } else {
          watermarkSaved = maxSidstIndlaest;
        }
      } else if (!cleanRun) {
        logger.warn('[deltager-delta] Partiel kørsel (esError) — watermark IKKE rykket');
      }

      const durationMs = Date.now() - startTime;
      logger.log(
        `[deltager-delta] Done: ${deltagerUpserted} deltagere, ${relationerUpserted} relationer, ` +
          `watermark=${watermarkSaved ?? 'uændret'}, ${durationMs}ms`
      );

      return NextResponse.json({
        ok: true,
        windowDays,
        overlapMinutes,
        watermarkFrom: storedWatermark,
        fromDate,
        maxSidstIndlaest,
        watermarkSaved,
        pagesFetched,
        deltagereFetched: allDeltagere.length,
        relationerFetched: allRelationer.length,
        deltagerUpserted,
        relationerUpserted,
        partialError: esError,
        durationMs,
      });
    }
  );
}
