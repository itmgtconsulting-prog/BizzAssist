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

  // BIZZ-575 v2: Re-tilføjet salgshistorik (købspris) — bruger eksplicit
  // ønsker det på kortene. Ejerskab forbliver skipped da ejerNavn er redundant
  // på virksomhed-side. Salgshistorik har 5s timeout så slow-cases ikke
  // blokerer hele batchen.
  try {
    const [bbrAreasRes, matrikelRes, vurRes, salgRes] = await Promise.allSettled([
      // BIZZ-575: Dedupliker BBR-bygninger på id_lokalId (BBR returnerer ofte
      // samme bygning N gange) + ekskluder status=7 (nedrevet).
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
      // Salgshistorik (seneste købspris) — 5s timeout så slow EJF ikke blokerer
      fetch(`${baseUrl}/api/salgshistorik?bfeNummer=${bfe}`, {
        ...fetchOpts,
        signal: AbortSignal.timeout(5000),
      }).then(async (r) => {
        if (!r.ok) return null;
        const d = (await r.json()) as {
          handler?: Array<{
            kontantKoebesum?: number | null;
            samletKoebesum?: number | null;
            loesoeresum?: number | null;
            entreprisesum?: number | null;
            overtagelsesdato?: string | null;
            koebsaftaleDato?: string | null;
          }>;
        };
        // BIZZ-575 v5: Find seneste handel med faktisk købspris (ikke bare
        // første entry der ofte er prisløs ejerskifte fra arv/gaver/skifte).
        // Hvis ingen handel har pris, returnér seneste dato uden pris så
        // kortet kan vise "Overtaget DATE (pris ej oplyst)".
        const handler = d.handler ?? [];
        if (handler.length === 0) return null;
        const findPrice = (h: (typeof handler)[number]): number | null => {
          const v =
            h.kontantKoebesum ??
            h.samletKoebesum ??
            ((h.loesoeresum ?? 0) + (h.entreprisesum ?? 0) || null);
          return v && v > 0 ? v : null;
        };
        const medPris = handler.find((h) => findPrice(h) != null);
        const seneste = medPris ?? handler[0];
        return {
          koebesum: medPris ? findPrice(medPris) : null,
          koebsdato: seneste.overtagelsesdato ?? seneste.koebsaftaleDato ?? null,
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
      const v = vurRes.value as {
        vurdering: number | null;
        aar: number | null;
        erGrundvaerdi: boolean;
      };
      result.vurdering = v.vurdering;
      result.vurderingsaar = v.aar;
      result.erGrundvaerdi = v.erGrundvaerdi;
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
