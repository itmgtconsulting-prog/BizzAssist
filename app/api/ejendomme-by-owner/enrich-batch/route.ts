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
import { selectPrimaryOwner, type EjerCandidate } from '../enrich/selectPrimaryOwner';
import { fetchBbrAreasByDawaId } from '@/app/lib/fetchBbrData';
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
    signal: AbortSignal.timeout(8000),
  };

  try {
    const [bbrAreasRes, matrikelRes, vurRes, ejRes, salgRes] = await Promise.allSettled([
      dawaId ? fetchBbrAreasByDawaId(dawaId) : Promise.resolve(null),
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
        const v =
          nyeste.ejendomsvaerdi && nyeste.ejendomsvaerdi > 0
            ? nyeste.ejendomsvaerdi
            : (nyeste.grundvaerdi ?? null);
        return v && v > 0 ? { vurdering: v, aar: nyeste.vurderingsaar } : null;
      }),
      fetch(`${baseUrl}/api/ejerskab?bfeNummer=${bfe}`, fetchOpts).then(async (r) => {
        if (!r.ok) return null;
        const d = await r.json();
        const ejere = (d?.ejere ?? []) as EjerCandidate[];
        const primary = selectPrimaryOwner(ejere);
        if (!primary) return { ejerNavn: null };
        if (primary.cvr) {
          try {
            const nameRes = await fetch(
              `${baseUrl}/api/cvr-public?vat=${encodeURIComponent(primary.cvr)}`,
              fetchOpts
            );
            if (nameRes.ok) {
              const nameData = (await nameRes.json()) as { name?: string };
              if (nameData.name) return { ejerNavn: nameData.name };
            }
          } catch {
            /* fall through */
          }
          return { ejerNavn: `CVR ${primary.cvr}` };
        }
        return { ejerNavn: primary.personNavn };
      }),
      fetch(`${baseUrl}/api/salgshistorik?bfeNummer=${bfe}`, fetchOpts).then(async (r) => {
        if (!r.ok) return null;
        const d = (await r.json()) as {
          handler?: Array<{
            kontantKoebesum?: number | null;
            samletKoebesum?: number | null;
            overtagelsesdato?: string | null;
            koebsaftaleDato?: string | null;
          }>;
        };
        const latest = (d.handler ?? [])[0];
        if (!latest) return null;
        return {
          koebesum: latest.kontantKoebesum ?? latest.samletKoebesum ?? null,
          koebsdato: latest.overtagelsesdato ?? latest.koebsaftaleDato ?? null,
        };
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
      const v = vurRes.value as { vurdering: number | null; aar: number | null };
      result.vurdering = v.vurdering;
      result.vurderingsaar = v.aar;
    }
    if (ejRes.status === 'fulfilled' && ejRes.value) {
      const e = ejRes.value as { ejerNavn: string | null };
      result.ejerNavn = e.ejerNavn;
    }
    if (salgRes.status === 'fulfilled' && salgRes.value) {
      const s = salgRes.value as { koebesum: number | null; koebsdato: string | null };
      result.koebesum = s.koebesum;
      result.koebsdato = s.koebsdato;
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
