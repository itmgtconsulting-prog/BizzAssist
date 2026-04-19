/**
 * GET /api/ejendomme-by-owner/enrich-batch?bfes=1,2,3&dawaIds=uuid1,uuid2,uuid3
 *
 * BIZZ-569 follow-up: Batch-version af /api/ejendomme-by-owner/enrich.
 * Klienten kalder ÉT endpoint med alle BFE+dawaIds i stedet for ét kald
 * per kort. Det fjerner cold-start × N-problemet på Vercel og halverer
 * typisk total-latency for siden ved 3+ kort.
 *
 * Begge param er komma-separeret. dawaIds index'eres parallelt med bfes;
 * hvis dawaId mangler for en BFE, send tom streng (`,,uuid3`).
 *
 * Returnerer: { [bfe]: { areal, vurdering, vurderingsaar, ejerNavn,
 *                       koebesum, koebsdato, boligAreal, erhvervsAreal,
 *                       matrikelAreal } }
 *
 * Hver BFE-enrichment kører parallelt via samme logik som single-enrich
 * endpoint. Bemærk: ingen ekstern HTTP-roundtrip mellem batch og single
 * — vi inliner core-funktionaliteten direkte mod underlæggende kilder
 * (BBR, DAWA, VUR, EJF, salgshistorik).
 *
 * Cache: 24t public + 6t SWR (samme som single-enrich).
 *
 * @module api/ejendomme-by-owner/enrich-batch
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { fetchBbrAreasByBfe } from '@/app/lib/fetchBbrData';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Maks antal BFE'er per batch-kald (beskyttelse mod misbrug + serverless-loft) */
const MAX_BATCH = 50;

const querySchema = z.object({
  bfes: z.string().regex(/^[\d,]+$/, 'bfes skal være komma-separeret tal'),
  dawaIds: z.string().optional(),
});

/** Result-shape per BFE — matcher single-enrich-endpointet 1:1 */
interface EnrichedRow {
  areal: number | null;
  vurdering: number | null;
  vurderingsaar: number | null;
  /** BIZZ-575: True hvis 'vurdering' er grundværdi (ejendomsværdi var 0) */
  erGrundvaerdi: boolean;
  ejerNavn: string | null;
  koebesum: number | null;
  koebsdato: string | null;
  boligAreal: number | null;
  erhvervsAreal: number | null;
  matrikelAreal: number | null;
}

const empty = (): EnrichedRow => ({
  areal: null,
  vurdering: null,
  vurderingsaar: null,
  erGrundvaerdi: false,
  ejerNavn: null,
  koebesum: null,
  koebsdato: null,
  boligAreal: null,
  erhvervsAreal: null,
  matrikelAreal: null,
});

/**
 * Enricher én enkelt BFE — wrapper omkring de samme parallelle fetches som
 * single-enrich-endpointet. Returnerer altid en row (tomt objekt ved fejl).
 */
async function enrichOne(
  bfe: string,
  dawaId: string | undefined,
  baseUrl: string,
  cookieHeader: string
): Promise<EnrichedRow> {
  const result = empty();
  const fetchOpts: RequestInit = {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    signal: AbortSignal.timeout(6000),
  };

  // BIZZ-569 v2 perf: Drop ejerskab + salgshistorik fra batch — disse var de
  // langsomste sub-fetches (intern HTTP-roundtrip × N) og ejerNavn er
  // redundant på virksomhed-side (vi er på virksomhedens side, ejerNavn ER
  // virksomheden). Card kan stadig hente disse on-demand hvis nødvendigt.
  try {
    const [bbrAreasRes, matrikelRes, vurRes] = await Promise.allSettled([
      // BIZZ-575: Filtrér på BFE (ikke kun husnummer) så bygninger fra
      // andre BFE'er på samme adresse ikke summes med + ekskluder status=7.
      fetchBbrAreasByBfe(parseInt(bfe, 10), dawaId ?? null),
      fetch(`${DAWA_BASE_URL}/jordstykker?bfenummer=${bfe}&per_side=1`, {
        signal: AbortSignal.timeout(5000),
        next: { revalidate: 86400 },
      }).then(async (r) => {
        if (!r.ok) return null;
        const arr = (await r.json()) as Array<{ registreretareal?: number }>;
        return arr[0]?.registreretareal ?? null;
      }),
      fetch(`${baseUrl}/api/vurdering-forelobig?bfeNummer=${bfe}`, fetchOpts).then(async (r) => {
        if (!r.ok) return null;
        const d = (await r.json()) as {
          forelobige?: Array<{
            vurderingsaar: number;
            ejendomsvaerdi: number | null;
            grundvaerdi: number | null;
          }>;
        };
        const nyeste = d.forelobige?.[0];
        if (!nyeste) return null;
        const erEjendomsvaerdi = !!(nyeste.ejendomsvaerdi && nyeste.ejendomsvaerdi > 0);
        const v = erEjendomsvaerdi ? nyeste.ejendomsvaerdi! : (nyeste.grundvaerdi ?? null);
        return v && v > 0
          ? { vurdering: v, aar: nyeste.vurderingsaar, erGrundvaerdi: !erEjendomsvaerdi }
          : null;
      }),
    ]);

    if (bbrAreasRes.status === 'fulfilled' && bbrAreasRes.value) {
      const a = bbrAreasRes.value as {
        boligAreal: number | null;
        erhvervsAreal: number | null;
        samletBygningsareal: number | null;
      };
      result.boligAreal = a.boligAreal;
      result.erhvervsAreal = a.erhvervsAreal;
      result.areal = a.samletBygningsareal;
    }
    if (matrikelRes.status === 'fulfilled' && matrikelRes.value != null) {
      result.matrikelAreal = matrikelRes.value as number;
    }
    if (vurRes.status === 'fulfilled' && vurRes.value) {
      const v = vurRes.value as {
        vurdering: number | null;
        aar: number | null;
        erGrundvaerdi: boolean;
      };
      result.vurdering = v.vurdering;
      result.vurderingsaar = v.aar;
      result.erGrundvaerdi = v.erGrundvaerdi;
    }
  } catch (err) {
    logger.error(`[enrich-batch] BFE ${bfe} fejl:`, err);
  }

  return result;
}

/**
 * GET /api/ejendomme-by-owner/enrich-batch
 * Batch-enrich flere BFE'er i ÉT kald.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) return parsed.response;
  const { bfes, dawaIds } = parsed.data;

  const bfeList = bfes.split(',').filter(Boolean).slice(0, MAX_BATCH);
  const dawaList = (dawaIds ?? '').split(',');

  const baseUrl = request.nextUrl.origin;
  const cookieHeader = request.headers.get('cookie') ?? '';

  const results = await Promise.all(
    bfeList.map((bfe, i) => enrichOne(bfe, dawaList[i] || undefined, baseUrl, cookieHeader))
  );

  const out: Record<string, EnrichedRow> = {};
  for (let i = 0; i < bfeList.length; i++) {
    out[bfeList[i]] = results[i];
  }

  return NextResponse.json(out, {
    headers: {
      'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=21600',
    },
  });
}
