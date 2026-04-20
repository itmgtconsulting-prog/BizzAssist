/**
 * Shared helper: henter seneste salgspris + dato for en BFE med EJF → TL fallback.
 *
 * Primær kilde: EJF_Ejerskifte + EJF_Handelsoplysninger (via /api/salgshistorik).
 * Fallback: Tinglysning adkomst-dokumenter (via /api/tinglysning + /api/tinglysning/summarisk).
 *
 * Bruges af både /api/ejendomme-by-owner/enrich (single) og
 * /api/ejendomme-by-owner/enrich-batch (bulk) for at sikre konsistent adfærd —
 * BIZZ-609 afdækkede at single-enrich kun brugte EJF uden fallback, hvilket
 * viste "ingen handel" på ejendomme hvor Tinglysning HAVDE købsdata (typiske
 * intra-koncern-overdragelser og ejerlejlighed-nye-BFE'er der ikke altid
 * registreres i EJF).
 */

import { logger } from '@/app/lib/logger';

export interface SalgResult {
  koebesum: number | null;
  koebsdato: string | null;
}

/**
 * Hent salgspris + dato for en BFE. Prøver EJF først, falder tilbage til
 * Tinglysning hvis EJF ikke har en registreret handel.
 *
 * @param bfe - BFE-nummer som streng eller tal
 * @param baseUrl - Request-originen (fx request.nextUrl.origin)
 * @param cookieHeader - Videresender session-cookie til interne auth-krævende routes
 * @param timeoutMs - Pr. kilde-timeout i ms (default 5000)
 * @returns { koebesum, koebsdato } — begge kan være null
 */
export async function fetchSalgshistorikMedFallback(
  bfe: number | string,
  baseUrl: string,
  cookieHeader: string,
  timeoutMs = 5000
): Promise<SalgResult | null> {
  const fetchOpts: RequestInit = {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  };

  const ejfPromise: Promise<SalgResult | null> = fetch(
    `${baseUrl}/api/salgshistorik?bfeNummer=${bfe}`,
    { ...fetchOpts, signal: AbortSignal.timeout(timeoutMs) }
  )
    .then(async (r) => {
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
    })
    .catch(() => null);

  const tlPromise: Promise<SalgResult | null> = (async () => {
    try {
      const tlRes = await fetch(`${baseUrl}/api/tinglysning?bfe=${bfe}`, {
        ...fetchOpts,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!tlRes.ok) return null;
      const tlData = (await tlRes.json()) as { uuid?: string; error?: string };
      if (!tlData.uuid || tlData.error) return null;

      const sumRes = await fetch(
        `${baseUrl}/api/tinglysning/summarisk?uuid=${tlData.uuid}&section=ejere`,
        { ...fetchOpts, signal: AbortSignal.timeout(timeoutMs + 3000) }
      );
      if (!sumRes.ok) return null;
      const sumData = (await sumRes.json()) as {
        ejere?: Array<{
          koebesum?: number | null;
          overtagelsesdato?: string | null;
        }>;
      };
      const ejere = sumData.ejere ?? [];
      // Nyeste adkomst med faktisk pris (skoede/auktionsskoede) — spring
      // arv/gave over hvis de ikke har pris.
      const medPris = ejere.find((e) => e.koebesum && e.koebesum > 0);
      if (!medPris) return null;
      return {
        koebesum: medPris.koebesum ?? null,
        koebsdato: medPris.overtagelsesdato ?? null,
      };
    } catch (err) {
      logger.warn(`[salgshistorik-fallback] TL lookup for BFE ${bfe} fejlede:`, err);
      return null;
    }
  })();

  const [ejfResult, tlResult] = await Promise.allSettled([ejfPromise, tlPromise]);
  const ejf = ejfResult.status === 'fulfilled' ? ejfResult.value : null;
  const tl = tlResult.status === 'fulfilled' ? tlResult.value : null;

  // Foretræk EJF når den har pris; ellers brug Tinglysning; ellers behold
  // hvad der er tilbage (kan være EJF med dato uden pris).
  if (ejf?.koebesum) return ejf;
  if (tl?.koebesum) return tl;
  return ejf ?? tl;
}
