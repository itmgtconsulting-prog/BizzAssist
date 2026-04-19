/**
 * GET /api/ejendomme-by-owner/enrich?bfe=100165718
 *
 * Progressive enrichment endpoint for property cards (BIZZ-397).
 * Returns areal, vurdering, ejer-navn, and købs-info for a single BFE.
 * Called client-side in batches after initial property list renders.
 *
 * Data sources:
 *   - BBR v2 GraphQL → bygningsareal
 *   - VUR v2 GraphQL → ejendomsvurdering
 *   - EJF Custom → ejer-navn
 *   - EJF Ejerskifte → seneste handel (købesum, dato)
 *
 * @param bfe - BFE-nummer
 * @returns { areal, vurdering, vurderingsaar, ejerNavn, koebesum, koebsdato }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { selectPrimaryOwner, type EjerCandidate } from './selectPrimaryOwner';
import { fetchBbrAreasByDawaId } from '@/app/lib/fetchBbrData';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';

export const runtime = 'nodejs';
export const maxDuration = 15;

const enrichSchema = z.object({
  bfe: z.string().regex(/^\d+$/, 'bfe skal være numerisk'),
  // BIZZ-569: Klienten sender også dawaId så vi kan slå BBR-bygningsareal op
  // direkte. Tidligere blev der kaldt /api/bbr/bbox?bfe=X som ikke understøtter
  // bfe-param og returnerede tom (areal var derfor altid null på cards).
  dawaId: z.string().uuid().optional().or(z.literal('')),
});

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, enrichSchema);
  if (!parsed.success) return parsed.response;
  const { bfe, dawaId } = parsed.data;

  const result: {
    areal: number | null;
    vurdering: number | null;
    vurderingsaar: number | null;
    ejerNavn: string | null;
    koebesum: number | null;
    koebsdato: string | null;
    /** BIZZ-569: Bolig m² fra BBR (sum over bygninger på adressen) */
    boligAreal: number | null;
    /** BIZZ-569: Erhverv m² fra BBR (sum over bygninger på adressen) */
    erhvervsAreal: number | null;
    /** BIZZ-569: Matrikel-areal fra DAWA jordstykker (registreret_areal) */
    matrikelAreal: number | null;
  } = {
    areal: null,
    vurdering: null,
    vurderingsaar: null,
    ejerNavn: null,
    koebesum: null,
    koebsdato: null,
    boligAreal: null,
    erhvervsAreal: null,
    matrikelAreal: null,
  };

  const baseUrl = request.nextUrl.origin;
  const cookieHeader = request.headers.get('cookie') ?? '';
  const fetchOpts: RequestInit = {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    signal: AbortSignal.timeout(8000),
  };

  try {
    // Parallel: BBR areal + vurdering + ejerskab + salgshistorik + matrikel
    // BIZZ-569: BBR-areal henter bolig + erhverv + samlet bygningsareal i ÉT
    // GraphQL-kald via fetchBbrAreasByDawaId (kræver dawaId). Tidligere kald
    // til /api/bbr/bbox?bfe=X virkede ikke (bbox forventer bbox-koords).
    // Matrikel-areal hentes via DAWA jordstykker.
    const [bbrAreasRes, matrikelRes, vurRes, ejRes, salgRes] = await Promise.allSettled([
      // BBR-areal direkte via dawaId (skip hvis vi ikke har dawaId)
      dawaId ? fetchBbrAreasByDawaId(dawaId) : Promise.resolve(null),
      // Matrikel-areal fra DAWA jordstykker (registreret_areal i m²)
      fetch(`${DAWA_BASE_URL}/jordstykker?bfenummer=${bfe}&per_side=1`, {
        signal: AbortSignal.timeout(5000),
        next: { revalidate: 86400 },
      }).then(async (r) => {
        if (!r.ok) return null;
        const arr = (await r.json()) as Array<{ registreretareal?: number }>;
        return arr[0]?.registreretareal ?? null;
      }),
      // Vurdering — BIZZ-569: Foretræk FORELØBIG vurdering (Vurderings-
      // portalen 2025) over historisk VUR-data. Hvis foreloebig.ejendomsvaerdi
      // er 0 (typisk for erhverv), fallback til foreloebig.grundvaerdi.
      // Ellers fallback til ældre VUR-data.
      Promise.allSettled([
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
          // Foretræk ejendomsvaerdi når > 0; ellers grundvaerdi (typisk
          // erhvervsejendomme der får grundværdi i stedet for ejendomsværdi).
          const v =
            nyeste.ejendomsvaerdi && nyeste.ejendomsvaerdi > 0
              ? nyeste.ejendomsvaerdi
              : (nyeste.grundvaerdi ?? null);
          return v && v > 0 ? { vurdering: v, aar: nyeste.vurderingsaar } : null;
        }),
        fetch(`${baseUrl}/api/vurdering?bfeNummer=${bfe}`, fetchOpts).then(async (r) => {
          if (!r.ok) return null;
          const d = await r.json();
          const v = d?.vurdering?.ejendomsvaerdi;
          return v && v > 0 ? { vurdering: v, aar: d?.vurdering?.aar ?? null } : null;
        }),
      ]).then((results) => {
        const [foreloebig, vur] = results;
        if (foreloebig.status === 'fulfilled' && foreloebig.value) return foreloebig.value;
        if (vur.status === 'fulfilled' && vur.value) return vur.value;
        return null;
      }),
      // Ejerskab (ejer-navn + seneste handel)
      // BIZZ-460: Vælg den ejer der reelt har størst andel i stedet for
      // blindt at tage ejere[0]. Slå virksomhedsnavn op når CVR-ejer så
      // kortet ikke bare viser "CVR 12345678".
      fetch(`${baseUrl}/api/ejerskab?bfeNummer=${bfe}`, fetchOpts).then(async (r) => {
        if (!r.ok) return null;
        const d = await r.json();
        const ejere = (d?.ejere ?? []) as EjerCandidate[];
        const primary = selectPrimaryOwner(ejere);
        if (!primary) return { ejerNavn: null };

        if (primary.cvr) {
          // Slå virksomhedsnavn op via CVR proxy. Falder tilbage til rå CVR
          // hvis opslag fejler — bedre at vise CVR end ingenting.
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
            // Fald igennem til rå CVR
          }
          return { ejerNavn: `CVR ${primary.cvr}` };
        }

        return { ejerNavn: primary.personNavn };
      }),
      // BIZZ-465: Seneste handel (købspris + dato) fra /api/salgshistorik
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
          // Foretrækker overtagelsesdato (juridisk ejerskifte) — falder tilbage til
          // købsaftaleDato hvis overtagelse mangler.
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
      // Behold result.areal for backwards-compat (bruges fortsat i andre kort)
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
    logger.error('[ejendomme-by-owner/enrich] Error:', err);
  }

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
  });
}
