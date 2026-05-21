/**
 * BIZZ-1737: Collect comprehensive ejendomsdata from all BizzAssist sources.
 *
 * Orchestrates parallel fetches from:
 *   - BBR GraphQL (bygningsdata, enheder, opvarmning, materialer)
 *   - Vurdering cache / VUR GraphQL (ejendomsvaerdi, grundvaerdi, skat)
 *   - EJF ejerskab (aktuelle ejere + andele)
 *   - EJF ejerskifte + handelsoplysninger (salgshistorik med priser)
 *   - Tinglysning S2S (servitutter + haeftelser)
 *   - DAWA (matrikel, grundareal, kommune, zone, beliggenhed)
 *
 * All fetches are non-fatal — partial data is better than no data.
 * The result feeds into generate-tabs as context for AI tab generation.
 *
 * @module app/lib/vurdering/collectEjendomData
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchBbrAreasByBfe, resolveMatrikelArealByBfe } from '@/app/lib/fetchBbrData';
import { fetchServitutterByBfe, fetchHaeftelserByBfe } from '@/app/lib/s2sOperations';
import type { ServitutRow, HaeftelseRow } from '@/app/lib/s2sOperations';
import { dawaHentAdresse } from '@/app/lib/dawa';
import type { DawaAdresse } from '@/app/lib/dawa';
import { getHandelstypeInfo } from '@/app/lib/ejfKoder';
import { logger } from '@/app/lib/logger';

// ─── Result types ──────────────────────────────────────────────────────────

/** BBR bygnings- og enhedsdata. */
export interface CollectedBbrData {
  opfoerelsesaar: number | null;
  omTilbygningsaar: number | null;
  bebyggetAreal: number | null;
  samletBygningsareal: number | null;
  samletBoligareal: number | null;
  samletErhvervsareal: number | null;
  grundareal: number | null;
  antalEtager: number | null;
  tagdaekningsmateriale: string | null;
  ydervaegMateriale: string | null;
  opvarmning: string | null;
  opvarmningsmiddel: string | null;
  supplerendeVarme: string | null;
  vandforsyning: string | null;
  afloebsforhold: string | null;
  bygningsanvendelse: string | null;
  ejerforholdskode: string | null;
  fredning: string | null;
  bevaringsvaerdighed: string | null;
  energimaerke: string | null;
  energimaerkeDato: string | null;
  asbestholdigtMateriale: string | null;
}

/** Vurderingsdata fra VUR / cache. */
export interface CollectedVurderingData {
  ejendomsvaerdi: number | null;
  grundvaerdi: number | null;
  afgiftspligtigEjendomsvaerdi: number | null;
  afgiftspligtigGrundvaerdi: number | null;
  estimeretGrundskyld: number | null;
  grundskyldspromille: number | null;
  vurderingsaar: number | null;
  benyttelseskode: string | null;
  juridiskKategori: string | null;
  bebyggelsesprocent: number | null;
  vurderetAreal: number | null;
}

/** Ejer fra EJF. */
export interface CollectedEjer {
  navn: string | null;
  cvr: number | null;
  type: string | null;
  andelProcent: string | null;
  virkningFra: string | null;
}

/** Handel fra EJF ejerskifte + handelsoplysninger. */
export interface CollectedHandel {
  overtagelsesdato: string | null;
  koebsaftaleDato: string | null;
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  overdragelsesmaade: string | null;
  overdragelsesmaadeLabel: string | null;
  betinget: boolean | null;
  ejerNavn: string | null;
  ejerCvr: number | null;
}

/** Matrikel og beliggenhed fra DAWA. */
export interface CollectedBeliggenhed {
  adresse: string | null;
  vejnavn: string | null;
  husnr: string | null;
  etage: string | null;
  doer: string | null;
  postnr: string | null;
  postnrnavn: string | null;
  kommunenavn: string | null;
  regionsnavn: string | null;
  zone: string | null;
  matrikelnr: string | null;
  ejerlavsnavn: string | null;
  ejerlavskode: number | null;
  grundareal: number | null;
  koordinater: { x: number; y: number } | null;
}

/** Samlet resultat fra alle kilder. */
export interface CollectedEjendomData {
  bfe: number;
  bbr: CollectedBbrData | null;
  vurdering: CollectedVurderingData | null;
  ejere: CollectedEjer[];
  salgshistorik: CollectedHandel[];
  servitutter: ServitutRow[];
  haeftelser: HaeftelseRow[];
  beliggenhed: CollectedBeliggenhed | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch BBR data from cache table, enriched with live areal-lookup.
 */
async function collectBbr(bfe: number, dawaId: string | null): Promise<CollectedBbrData | null> {
  try {
    const admin = createAdminClient();

    // Parallel: cache table + live areal + matrikel-areal
    const [cacheResult, liveAreal, grundareal] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any).from('bbr_ejendom_status').select('*').eq('bfe_nummer', bfe).maybeSingle(),
      dawaId ? fetchBbrAreasByBfe(bfe, dawaId) : Promise.resolve(null),
      resolveMatrikelArealByBfe(bfe),
    ]);

    const cache = cacheResult?.data as Record<string, unknown> | null;

    // Merge: prefer cache data, supplement with live where cache is sparse
    return {
      opfoerelsesaar: (cache?.opfoerelsesaar as number) ?? null,
      omTilbygningsaar: (cache?.ombygningsaar as number) ?? null,
      bebyggetAreal: (cache?.bebygget_areal as number) ?? null,
      samletBygningsareal: liveAreal?.samletBygningsareal ?? null,
      samletBoligareal: liveAreal?.boligAreal ?? (cache?.samlet_boligareal as number) ?? null,
      samletErhvervsareal:
        liveAreal?.erhvervsAreal ?? (cache?.samlet_erhvervsareal as number) ?? null,
      grundareal: grundareal ?? (cache?.grundareal as number) ?? null,
      antalEtager: (cache?.antal_etager as number) ?? null,
      tagdaekningsmateriale: (cache?.tagmateriale as string) ?? null,
      ydervaegMateriale: (cache?.ydervaeg_materiale as string) ?? null,
      opvarmning: (cache?.varmeinstallation as string) ?? null,
      opvarmningsmiddel: (cache?.opvarmningsform as string) ?? null,
      supplerendeVarme: (cache?.supplerende_varme as string) ?? null,
      vandforsyning: (cache?.vandforsyning as string) ?? null,
      afloebsforhold: (cache?.afloebsforhold as string) ?? null,
      bygningsanvendelse: (cache?.byg021_anvendelse as string) ?? null,
      ejerforholdskode: (cache?.ejerforholdskode as string) ?? null,
      fredning: (cache?.fredning as string) ?? null,
      bevaringsvaerdighed: (cache?.bevaringsvaerdighed as string) ?? null,
      energimaerke: (cache?.energimaerke as string) ?? null,
      energimaerkeDato: (cache?.energimaerke_dato as string) ?? null,
      asbestholdigtMateriale: null, // Not stored in cache — available from live BBR only
    };
  } catch (err) {
    logger.warn('[collectEjendomData] BBR fetch failed', err);
    return null;
  }
}

/**
 * Fetch vurdering from cache table.
 */
async function collectVurdering(bfe: number): Promise<CollectedVurderingData | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('vurdering_cache')
      .select(
        'ejendomsvaerdi, grundvaerdi, vurderingsaar, benyttelseskode, grundskyldspromille, bebyggelsesprocent, vurderinger, skatteberegning'
      )
      .eq('bfe_nummer', bfe)
      .maybeSingle();

    if (!data) return null;
    const d = data as Record<string, unknown>;

    // Extract extended fields from JSONB vurderinger array (index 0 = newest)
    const vurArr = d.vurderinger as Array<Record<string, unknown>> | null;
    const nyeste = vurArr?.[0] ?? null;
    const skat = d.skatteberegning as Record<string, unknown> | null;

    return {
      ejendomsvaerdi: (d.ejendomsvaerdi as number) ?? null,
      grundvaerdi: (d.grundvaerdi as number) ?? null,
      afgiftspligtigEjendomsvaerdi: (nyeste?.afgiftspligtigEjendomsvaerdi as number) ?? null,
      afgiftspligtigGrundvaerdi: (nyeste?.afgiftspligtigGrundvaerdi as number) ?? null,
      estimeretGrundskyld: (skat?.grundskyld as number) ?? null,
      grundskyldspromille: (d.grundskyldspromille as number) ?? null,
      vurderingsaar: (d.vurderingsaar as number) ?? null,
      benyttelseskode: (d.benyttelseskode as string) ?? null,
      juridiskKategori: (nyeste?.juridiskKategori as string) ?? null,
      bebyggelsesprocent: (d.bebyggelsesprocent as number) ?? null,
      vurderetAreal: (nyeste?.vurderetAreal as number) ?? null,
    };
  } catch (err) {
    logger.warn('[collectEjendomData] vurdering fetch failed', err);
    return null;
  }
}

/**
 * Fetch current owners from ejf_ejerskab.
 */
async function collectEjere(bfe: number): Promise<CollectedEjer[]> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('ejf_ejerskab')
      .select('ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, virkning_fra')
      .eq('bfe_nummer', bfe)
      .eq('status', 'gældende')
      .limit(20);

    if (!data) return [];
    return (data as Array<Record<string, unknown>>).map((e) => {
      const t = e.ejerandel_taeller as number | null;
      const n = e.ejerandel_naevner as number | null;
      let andelProcent: string | null = null;
      if (t != null && n != null && n > 0) {
        const pct = Math.round((t / n) * 100);
        andelProcent = `${pct}%`;
      }
      return {
        navn: (e.ejer_navn as string) ?? null,
        cvr: (e.ejer_cvr as number) ?? null,
        type: (e.ejer_type as string) ?? null,
        andelProcent,
        virkningFra: (e.virkning_fra as string) ?? null,
      };
    });
  } catch (err) {
    logger.warn('[collectEjendomData] ejere fetch failed', err);
    return [];
  }
}

/**
 * Fetch salgshistorik from ejf_ejerskifte + ejf_handelsoplysninger.
 */
async function collectSalgshistorik(bfe: number): Promise<CollectedHandel[]> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerskifter } = await (admin as any)
      .from('ejf_ejerskifte')
      .select(
        'overtagelsesdato, overdragelsesmaade, betinget, ejer_navn, ejer_cvr, handelsoplysninger_lokal_id'
      )
      .eq('bfe_nummer', bfe)
      .eq('status', 'gældende')
      .order('overtagelsesdato', { ascending: false })
      .limit(20);

    if (!ejerskifter || ejerskifter.length === 0) {
      // Fallback to ejerskifte_historik (older table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: historik } = await (admin as any)
        .from('ejerskifte_historik')
        .select('overtagelsesdato, ejer_navn, kontant_koebesum, i_alt_koebesum')
        .eq('bfe_nummer', bfe)
        .order('overtagelsesdato', { ascending: false })
        .limit(20);

      if (!historik) return [];
      return (historik as Array<Record<string, unknown>>).map((h) => ({
        overtagelsesdato: (h.overtagelsesdato as string) ?? null,
        koebsaftaleDato: null,
        kontantKoebesum: (h.kontant_koebesum as number) ?? null,
        samletKoebesum: (h.i_alt_koebesum as number) ?? null,
        overdragelsesmaade: null,
        overdragelsesmaadeLabel: null,
        betinget: null,
        ejerNavn: (h.ejer_navn as string) ?? null,
        ejerCvr: null,
      }));
    }

    // Enrich with handelsoplysninger for prices
    const handelsIds = (ejerskifter as Array<Record<string, unknown>>)
      .map((e) => e.handelsoplysninger_lokal_id as string | null)
      .filter((id): id is string => id != null);

    let handelsMap = new Map<string, Record<string, unknown>>();
    if (handelsIds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: handelsData } = await (admin as any)
        .from('ejf_handelsoplysninger')
        .select('id_lokal_id, samlet_koebesum, kontant_koebesum, koebsaftale_dato, valutakode')
        .in('id_lokal_id', handelsIds);

      if (handelsData) {
        handelsMap = new Map(
          (handelsData as Array<Record<string, unknown>>).map((h) => [h.id_lokal_id as string, h])
        );
      }
    }

    return (ejerskifter as Array<Record<string, unknown>>).map((e) => {
      const handelsId = e.handelsoplysninger_lokal_id as string | null;
      const handel = handelsId ? handelsMap.get(handelsId) : undefined;
      const maade = (e.overdragelsesmaade as string) ?? null;
      const info = maade ? getHandelstypeInfo(maade) : null;

      return {
        overtagelsesdato: (e.overtagelsesdato as string) ?? null,
        koebsaftaleDato: (handel?.koebsaftale_dato as string) ?? null,
        kontantKoebesum: (handel?.kontant_koebesum as number) ?? null,
        samletKoebesum: (handel?.samlet_koebesum as number) ?? null,
        overdragelsesmaade: maade,
        overdragelsesmaadeLabel: info?.label ?? maade,
        betinget: (e.betinget as boolean) ?? null,
        ejerNavn: (e.ejer_navn as string) ?? null,
        ejerCvr: (e.ejer_cvr as number) ?? null,
      };
    });
  } catch (err) {
    logger.warn('[collectEjendomData] salgshistorik fetch failed', err);
    return [];
  }
}

/**
 * Fetch beliggenhed from DAWA + matrikel data.
 */
async function collectBeliggenhed(
  dawaId: string | null,
  grundareal: number | null
): Promise<CollectedBeliggenhed | null> {
  if (!dawaId) return null;

  try {
    const adresse: DawaAdresse | null = await dawaHentAdresse(dawaId);
    if (!adresse) return null;

    return {
      adresse: adresse.adressebetegnelse ?? null,
      vejnavn: adresse.vejnavn ?? null,
      husnr: adresse.husnr ?? null,
      etage: adresse.etage ?? null,
      doer: adresse.dør ?? null,
      postnr: adresse.postnr ?? null,
      postnrnavn: adresse.postnrnavn ?? null,
      kommunenavn: adresse.kommunenavn ?? null,
      regionsnavn: adresse.regionsnavn ?? null,
      zone: adresse.zone ?? null,
      matrikelnr: adresse.matrikelnr ?? null,
      ejerlavsnavn: adresse.ejerlavsnavn ?? null,
      ejerlavskode: adresse.ejerlavskode ?? null,
      grundareal,
      koordinater: adresse.x && adresse.y ? { x: adresse.x, y: adresse.y } : null,
    };
  } catch (err) {
    logger.warn('[collectEjendomData] beliggenhed fetch failed', err);
    return null;
  }
}

// ─── Main orchestrator ─────────────────────────────────────────────────────

/**
 * Collect all available ejendomsdata for a BFE from BizzAssist sources.
 *
 * All fetches run in parallel where possible and are individually non-fatal.
 * Returns partial data when some sources are unavailable.
 *
 * @param bfe - BFE-nummer for ejendommen
 * @param dawaId - DAWA adresse/adgangsadresse UUID (nullable)
 * @returns Samlet ejendomsdata fra alle tilgaengelige kilder
 */
export async function collectEjendomData(
  bfe: number,
  dawaId: string | null
): Promise<CollectedEjendomData> {
  // Phase 1: Parallel independent fetches
  const [bbr, vurdering, ejere, salgshistorik, servitutter, haeftelser] = await Promise.all([
    collectBbr(bfe, dawaId),
    collectVurdering(bfe),
    collectEjere(bfe),
    collectSalgshistorik(bfe),
    fetchServitutterByBfe(bfe),
    fetchHaeftelserByBfe(bfe),
  ]);

  // Phase 2: Beliggenhed (needs grundareal from BBR phase)
  const beliggenhed = await collectBeliggenhed(dawaId, bbr?.grundareal ?? null);

  return {
    bfe,
    bbr,
    vurdering,
    ejere,
    salgshistorik,
    servitutter,
    haeftelser,
    beliggenhed,
  };
}
