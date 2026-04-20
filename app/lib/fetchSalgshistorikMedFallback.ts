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
 *
 * BIZZ-634: Udvidet til at returnere ejer-specifik købs- og salgspris når
 * ownerSellDate er kendt (historiske/solgte ejendomme). Uden ownerSellDate
 * beholdes den oprindelige "nyeste handel med pris"-adfærd for aktive
 * ejendomme (bagudkompatibel).
 */

import { logger } from '@/app/lib/logger';

export interface SalgResult {
  koebesum: number | null;
  koebsdato: string | null;
  /**
   * BIZZ-634: Salgspris for den konkrete ejer (kun sat når ownerSellDate
   * blev angivet i kaldet og den tilsvarende handel kunne findes).
   */
  salgesum?: number | null;
  /**
   * BIZZ-634: Salgsdato for den konkrete ejer. Matcher EJF_Ejerskifte.
   * overtagelsesdato på den handel hvor næste ejer overtog.
   */
  salgesdato?: string | null;
}

/** Shape af et handel-entry fra /api/salgshistorik (delmængde vi bruger). */
interface HandelEntry {
  kontantKoebesum?: number | null;
  samletKoebesum?: number | null;
  loesoeresum?: number | null;
  entreprisesum?: number | null;
  overtagelsesdato?: string | null;
  koebsaftaleDato?: string | null;
}

/**
 * Ekstrakt af beregnet handelspris med samme præference-regel som de gamle
 * kort: kontant først, så samlet, ellers sum af løsøre + entreprise.
 */
function findPrice(h: HandelEntry): number | null {
  const v =
    h.kontantKoebesum ??
    h.samletKoebesum ??
    ((h.loesoeresum ?? 0) + (h.entreprisesum ?? 0) || null);
  return v && v > 0 ? v : null;
}

/**
 * Konverterer ISO-dato til epoch-ms; null/ugyldig dato bliver 0.
 */
function dateMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Hent salgspris + dato for en BFE. Prøver EJF først, falder tilbage til
 * Tinglysning hvis EJF ikke har en registreret handel.
 *
 * BIZZ-634: Når `ownerSellDate` er angivet — dvs. vi kigger på en historisk/
 * solgt ejendom hvor vi ved hvornår ejeren afhændede den — forsøger helperen
 * at finde både:
 *
 *   • ejerens købs-handel: nyeste handel med pris som ligger strengt FØR
 *     ownerSellDate (og efter en evt. ownerBuyDate når vi kender den).
 *   • ejerens salgs-handel: handel med overtagelsesdato tættest på
 *     ownerSellDate (typisk identisk — EJF_Ejerskifte.overtagelsesdato bruges
 *     både af afgiver og erhverver).
 *
 * @param bfe - BFE-nummer som streng eller tal
 * @param baseUrl - Request-originen (fx request.nextUrl.origin)
 * @param cookieHeader - Videresender session-cookie til interne auth-krævende routes
 * @param timeoutMs - Pr. kilde-timeout i ms (default 5000)
 * @param ownerDates - Valgfri { buyDate, sellDate } ISO-strings — angiv for at
 *                     få ejer-specifik købspris + salgspris (BIZZ-634)
 * @returns { koebesum, koebsdato, salgesum?, salgesdato? } — felter kan være null
 */
export async function fetchSalgshistorikMedFallback(
  bfe: number | string,
  baseUrl: string,
  cookieHeader: string,
  timeoutMs = 5000,
  ownerDates?: { buyDate?: string | null; sellDate?: string | null } | null
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
      const d = (await r.json()) as { handler?: HandelEntry[] };
      const handler = d.handler ?? [];
      if (handler.length === 0) return null;
      return pickFromHandler(handler, ownerDates);
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

/**
 * BIZZ-634: Udvælger købs- og evt. salgs-handel fra en samlet liste af
 * handler-entries for en BFE. Handler-listen forventes nyeste-først.
 *
 * Uden ownerDates: bagudkompatibel adfærd — returnerer nyeste handel med
 * pris (eller nyeste handel uden pris).
 *
 * Med ownerDates.sellDate: udvælger salgs-handel (nærmest sellDate) og
 * købs-handel (nyeste pris-bærende handel strengt før sellDate, og
 * optionalt efter buyDate hvis angivet).
 */
function pickFromHandler(
  handler: HandelEntry[],
  ownerDates?: { buyDate?: string | null; sellDate?: string | null } | null
): SalgResult {
  const byDateDesc = [...handler].sort(
    (a, b) =>
      dateMs(b.overtagelsesdato ?? b.koebsaftaleDato) -
      dateMs(a.overtagelsesdato ?? a.koebsaftaleDato)
  );

  const sellDateMs = ownerDates?.sellDate ? dateMs(ownerDates.sellDate) : 0;
  const buyDateMs = ownerDates?.buyDate ? dateMs(ownerDates.buyDate) : 0;

  if (!sellDateMs) {
    // Legacy-adfærd: nyeste handel med pris.
    const medPris = byDateDesc.find((h) => findPrice(h) != null);
    const seneste = medPris ?? byDateDesc[0];
    return {
      koebesum: medPris ? findPrice(medPris) : null,
      koebsdato: seneste.overtagelsesdato ?? seneste.koebsaftaleDato ?? null,
    };
  }

  // Ejer-specifik opløsning: find salgs-handel tættest på sellDateMs, og
  // købs-handel blandt pris-bærende handler før sellDateMs.
  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
  const salg = byDateDesc.reduce<{ entry: HandelEntry; diff: number } | null>((best, h) => {
    const ms = dateMs(h.overtagelsesdato ?? h.koebsaftaleDato);
    if (!ms) return best;
    const diff = Math.abs(ms - sellDateMs);
    if (!best || diff < best.diff) return { entry: h, diff };
    return best;
  }, null);
  const salgHitErClose = salg ? salg.diff <= THIRTY_DAYS : false;

  const koebCandidates = byDateDesc.filter((h) => {
    const ms = dateMs(h.overtagelsesdato ?? h.koebsaftaleDato);
    if (!ms || ms >= sellDateMs) return false;
    if (buyDateMs && ms < buyDateMs - THIRTY_DAYS) return false;
    return findPrice(h) != null;
  });
  const koebHandel = koebCandidates[0] ?? null;

  const fallbackLatestWithPrice = byDateDesc.find((h) => findPrice(h) != null) ?? null;

  const koebesum = koebHandel
    ? findPrice(koebHandel)
    : fallbackLatestWithPrice
      ? findPrice(fallbackLatestWithPrice)
      : null;
  const koebsdato = koebHandel
    ? (koebHandel.overtagelsesdato ?? koebHandel.koebsaftaleDato ?? null)
    : (fallbackLatestWithPrice?.overtagelsesdato ??
      fallbackLatestWithPrice?.koebsaftaleDato ??
      null);

  const salgesum =
    salg && salgHitErClose && findPrice(salg.entry) != null ? findPrice(salg.entry) : null;
  const salgesdato =
    salg && salgHitErClose
      ? (salg.entry.overtagelsesdato ?? salg.entry.koebsaftaleDato ?? null)
      : null;

  return {
    koebesum,
    koebsdato,
    salgesum,
    salgesdato,
  };
}
