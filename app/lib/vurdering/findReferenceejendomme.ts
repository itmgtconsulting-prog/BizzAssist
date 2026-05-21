/**
 * BIZZ-1739: Auto-find referenceejendomme (comparable sales) for vurderingsrapport.
 *
 * Finder 3-5 sammenlignelige nylige handler i samme postnr-område med
 * lignende bygningstype. Beregner kvm-pris og trykprøver mod ejendommens
 * egen kvm-pris. Flagger afvigelse > 20%.
 *
 * Data: ejendomshandel × bbr_ejendom_status × bfe_adresse_cache.
 * Kræver at ejendomshandel er backfillet (BIZZ-1709).
 *
 * @module app/lib/vurdering/findReferenceejendomme
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

/** En referenceejendom med salgsdata + kvm-pris. */
export interface Referenceejendom {
  bfeNummer: number;
  adresse: string | null;
  postnr: string | null;
  salgsdato: string | null;
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  overdragelsesmaade: string | null;
  boligareal: number | null;
  kvmPris: number | null;
}

/** Trykprøvning af ejendommens pris mod referencer. */
export interface Trykproevning {
  ejendomKvmPris: number | null;
  referenceMedianKvmPris: number | null;
  referenceGennemsnitKvmPris: number | null;
  afvigelseProcent: number | null;
  flagget: boolean;
}

/** Samlet resultat fra referenceejendom-søgning. */
export interface ReferenceejendommeResult {
  referencer: Referenceejendom[];
  trykproevning: Trykproevning;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Beregn median af et array af tal. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── Main ─────────────────────────────────────────────────────────────────

/**
 * Find 3-5 sammenlignelige handler for en given ejendom.
 *
 * Strategi:
 *   1. Hent ejendommens postnr + byg021 + boligareal fra bbr/cache
 *   2. Søg i ejendomshandel for handler i samme postnr med lignende bygtype
 *   3. Filtrer: kun fri handel, inden for 3 år, med pris > 0
 *   4. Berig med adresse + boligareal fra bbr
 *   5. Beregn kvm-pris + trykprøvning
 *
 * @param bfe - BFE-nummer for ejendommen der vurderes
 * @param ejendomBoligareal - Ejendommens boligareal (fra BBR)
 * @param ejendomPris - Ejendommens seneste salgspris (nullable)
 * @returns Referenceejendomme + trykprøvning
 */
export async function findReferenceejendomme(
  bfe: number,
  ejendomBoligareal: number | null,
  ejendomPris: number | null
): Promise<ReferenceejendommeResult> {
  const emptyResult: ReferenceejendommeResult = {
    referencer: [],
    trykproevning: {
      ejendomKvmPris: null,
      referenceMedianKvmPris: null,
      referenceGennemsnitKvmPris: null,
      afvigelseProcent: null,
      flagget: false,
    },
  };

  try {
    const admin = createAdminClient();

    // Step 1: Hent ejendommens postnr + bygtype

    const [bbrResult, cacheResult] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any)
        .from('bbr_ejendom_status')
        .select('kommune_kode, byg021_anvendelse, samlet_boligareal')
        .eq('bfe_nummer', bfe)
        .maybeSingle(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any)
        .from('bfe_adresse_cache')
        .select('postnr, kommune_kode')
        .eq('bfe_nummer', bfe)
        .maybeSingle(),
    ]);

    const bbr = bbrResult?.data as Record<string, unknown> | null;
    const cache = cacheResult?.data as Record<string, unknown> | null;

    const postnr = (cache?.postnr as string) ?? null;
    const kommuneKode = (bbr?.kommune_kode as number) ?? (cache?.kommune_kode as number) ?? null;
    const byg021 = (bbr?.byg021_anvendelse as number) ?? null;
    const boligareal = ejendomBoligareal ?? (bbr?.samlet_boligareal as number) ?? null;

    if (!postnr && !kommuneKode) {
      logger.warn(`[referenceejendomme] Ingen postnr/kommune for BFE ${bfe}`);
      return emptyResult;
    }

    // Step 2: Find sammenlignelige handler via ejf_ejerskifte
    // BIZZ-1731: Brug ejf_ejerskifte med overdragelsesmaade-filter.
    // ejendomshandel-tabellen har ikke overdragelsesmaade i alle envs.
    const treAarSiden = new Date();
    treAarSiden.setFullYear(treAarSiden.getFullYear() - 3);
    const datoFilter = treAarSiden.toISOString().split('T')[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerskifter } = await (admin as any)
      .from('ejf_ejerskifte')
      .select('bfe_nummer, overtagelsesdato, overdragelsesmaade, handelsoplysninger_lokal_id')
      .neq('bfe_nummer', bfe)
      .eq('status', 'gældende')
      .gte('overtagelsesdato', datoFilter)
      .in('overdragelsesmaade', ['Almindelig fri handel', 'Almindelig fri handel særlige vilkår'])
      .not('handelsoplysninger_lokal_id', 'is', null)
      .order('overtagelsesdato', { ascending: false })
      .limit(100);

    if (!ejerskifter || ejerskifter.length === 0) {
      return emptyResult;
    }

    // Hent priser fra handelsoplysninger
    const handelsIds = (ejerskifter as Array<Record<string, unknown>>)
      .map((e) => e.handelsoplysninger_lokal_id as string)
      .filter((id, i, arr) => arr.indexOf(id) === i);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: handelsData } = await (admin as any)
      .from('ejf_handelsoplysninger')
      .select('id_lokal_id, samlet_koebesum, kontant_koebesum')
      .in('id_lokal_id', handelsIds.slice(0, 100));

    const handelsMap = new Map<string, Record<string, unknown>>(
      ((handelsData ?? []) as Array<Record<string, unknown>>).map((h) => [
        h.id_lokal_id as string,
        h,
      ])
    );

    // Byg handler-array med priser
    const handler = (ejerskifter as Array<Record<string, unknown>>)
      .map((e) => {
        const hId = e.handelsoplysninger_lokal_id as string;
        const h = handelsMap.get(hId);
        const kontant = (h?.kontant_koebesum as number) ?? null;
        const samlet = (h?.samlet_koebesum as number) ?? null;
        if (!kontant && !samlet) return null; // Ingen pris → skip
        return {
          bfe_nummer: e.bfe_nummer as number,
          dato: e.overtagelsesdato as string,
          kontant_koebesum: kontant,
          samlet_koebesum: samlet,
          overdragelsesmaade: e.overdragelsesmaade as string,
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);

    if (handler.length === 0) {
      return emptyResult;
    }

    // Step 3: Get postnr + boligareal for candidate BFEs
    const candidateBfes = handler
      .map((h) => h.bfe_nummer)
      .filter((b, i, arr) => arr.indexOf(b) === i);

    const [adresseResult, bbrBulkResult] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any)
        .from('bfe_adresse_cache')
        .select('bfe_nummer, adresse, postnr, postnrnavn')
        .in('bfe_nummer', candidateBfes.slice(0, 100)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any)
        .from('bbr_ejendom_status')
        .select('bfe_nummer, samlet_boligareal, byg021_anvendelse')
        .in('bfe_nummer', candidateBfes.slice(0, 100)),
    ]);

    const adresseMap = new Map<number, Record<string, unknown>>(
      ((adresseResult?.data ?? []) as Array<Record<string, unknown>>).map((a) => [
        a.bfe_nummer as number,
        a,
      ])
    );

    const bbrMap = new Map<number, Record<string, unknown>>(
      ((bbrBulkResult?.data ?? []) as Array<Record<string, unknown>>).map((b) => [
        b.bfe_nummer as number,
        b,
      ])
    );

    // Step 4: Filter + enrich + calculate kvm-pris
    const referencer: Referenceejendom[] = [];

    for (const h of handler) {
      const hBfe = h.bfe_nummer;
      const adresseInfo = adresseMap.get(hBfe);
      const bbrInfo = bbrMap.get(hBfe);

      // Filter: same postnr
      const hPostnr = adresseInfo?.postnr as string | null;
      if (postnr && hPostnr && hPostnr !== postnr) continue;

      // Filter: similar building type (same byg021 "category" — first digit)
      const hByg021 = bbrInfo?.byg021_anvendelse as number | null;
      if (byg021 && hByg021) {
        const cat1 = Math.floor(byg021 / 100);
        const cat2 = Math.floor(hByg021 / 100);
        if (cat1 !== cat2) continue;
      }

      const pris = h.kontant_koebesum ?? h.samlet_koebesum ?? null;
      const hAreal = bbrInfo?.samlet_boligareal as number | null;
      const kvmPris = pris && hAreal && hAreal > 0 ? Math.round(pris / hAreal) : null;

      // Build full adresse string
      const adresseStr = adresseInfo?.adresse as string | null;
      const postnrNavn = adresseInfo?.postnrnavn as string | null;
      const fullAdresse =
        adresseStr && hPostnr && postnrNavn
          ? `${adresseStr}, ${hPostnr} ${postnrNavn}`
          : adresseStr;

      referencer.push({
        bfeNummer: hBfe,
        adresse: fullAdresse ?? null,
        postnr: hPostnr ?? null,
        salgsdato: h.dato ?? null,
        kontantKoebesum: h.kontant_koebesum,
        samletKoebesum: h.samlet_koebesum,
        overdragelsesmaade: h.overdragelsesmaade ?? null,
        boligareal: hAreal ?? null,
        kvmPris,
      });

      if (referencer.length >= 5) break;
    }

    // Step 5: Trykprøvning
    const refKvmPriser = referencer
      .map((r) => r.kvmPris)
      .filter((p): p is number => p != null && p > 0);

    const ejendomKvmPris =
      ejendomPris && boligareal && boligareal > 0 ? Math.round(ejendomPris / boligareal) : null;

    const medianKvm = refKvmPriser.length > 0 ? Math.round(median(refKvmPriser)) : null;
    const gennemsnitKvm =
      refKvmPriser.length > 0
        ? Math.round(refKvmPriser.reduce((a, b) => a + b, 0) / refKvmPriser.length)
        : null;

    let afvigelseProcent: number | null = null;
    let flagget = false;
    if (ejendomKvmPris && medianKvm && medianKvm > 0) {
      afvigelseProcent = Math.round(((ejendomKvmPris - medianKvm) / medianKvm) * 100);
      flagget = Math.abs(afvigelseProcent) > 20;
    }

    return {
      referencer,
      trykproevning: {
        ejendomKvmPris,
        referenceMedianKvmPris: medianKvm,
        referenceGennemsnitKvmPris: gennemsnitKvm,
        afvigelseProcent,
        flagget,
      },
    };
  } catch (err) {
    logger.warn('[referenceejendomme] Lookup failed:', err);
    return emptyResult;
  }
}
