/**
 * koncernWalk — Traverserer ejerskabsstruktur og samler aktiver.
 *
 * BIZZ-1362: Ren funktion der tager en kunde (CVR eller enhedsNummer)
 * og returnerer en liste af aktiver (ejendomme, virksomheder,
 * bestyrelsesposter) via cache-tabeller.
 *
 * @module
 */

import { createAdminClient } from '@/lib/supabase/admin';

/** Et opdaget aktiv fra koncern-walk */
export interface Aktiv {
  /** Aktiv-type */
  type: 'ejendom' | 'virksomhed' | 'bil' | 'bestyrelsespost';
  /** Menneskelig label (adresse, virksomhedsnavn, rolle-beskrivelse) */
  label: string;
  /** BFE-nummer for ejendomme */
  bfe?: number;
  /** CVR-nummer for virksomheder */
  cvr?: string;
  /** Registreringsnummer for biler */
  regnr?: string;
  /** Estimeret værdi i DKK (ejendomsvurdering, aktiver etc.) */
  vaerdiDkk?: number;
  /** Hæftelser i DKK (tinglysning) */
  haeftelserDkk?: number;
  /** Byggeår (fra BBR) */
  byggeaar?: number;
  /** Antal ansatte (fra CVR) */
  ansatte?: number;
  /** Adresse (fra DAWA/BBR) */
  adresse?: string;
  /** Rå data for debugging/audit */
  rawData?: Record<string, unknown>;
}

/** Max aktiver returneret (sikkerhedsloft mod runaway-koncerner) */
const MAX_AKTIVER = 500;

/**
 * Walk koncern-struktur og saml aktiver.
 *
 * @param kundeType - 'virksomhed' eller 'person'
 * @param kundeId - CVR-nummer eller enhedsNummer
 * @param asOfDate - BIZZ-1355: Snapshot-dato for historiske opslag (null = aktuel dato)
 * @returns Array af opdagede aktiver
 */
export async function walkKoncern(
  kundeType: 'virksomhed' | 'person',
  kundeId: string,
  asOfDate?: Date | null
): Promise<Aktiv[]> {
  const admin = createAdminClient();
  const aktiver: Aktiv[] = [];
  const seenBfes = new Set<number>();
  const seenCvrs = new Set<string>();

  if (kundeType === 'virksomhed') {
    await walkVirksomhed(admin, kundeId, aktiver, seenBfes, seenCvrs, 0, asOfDate ?? null);
  } else {
    await walkPerson(admin, kundeId, aktiver, seenBfes, seenCvrs);
  }

  return aktiver.slice(0, MAX_AKTIVER);
}

/**
 * Walk en virksomhed: hent ejendomme + datterselskaber rekursivt.
 *
 * @param admin - Supabase admin client
 * @param cvr - CVR-nummer
 * @param aktiver - Mutable aktiver-array
 * @param seenBfes - Dedup set for ejendomme
 * @param seenCvrs - Dedup + cyclic detection for virksomheder
 * @param depth - Rekursionsdybde (max 3)
 * @param asOfDate - BIZZ-1355: Snapshot-dato (null = aktuel)
 */
async function walkVirksomhed(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string,
  aktiver: Aktiv[],
  seenBfes: Set<number>,
  seenCvrs: Set<string>,
  depth: number,
  asOfDate: Date | null
): Promise<void> {
  if (seenCvrs.has(cvr) || depth > 3 || aktiver.length >= MAX_AKTIVER) return;
  seenCvrs.add(cvr);

  // BIZZ-1443: Tilføj virksomheden selv som aktiv (for ansvarsforsikring-matching)
  const { data: virk } = await (admin as ReturnType<typeof createAdminClient>)
    .from('cvr_virksomhed')
    .select('navn, branche_tekst')
    .eq('cvr_nummer', cvr)
    .maybeSingle();
  aktiver.push({
    type: 'virksomhed',
    label: (virk as { navn?: string } | null)?.navn ?? `CVR ${cvr}`,
    cvr,
    rawData: { branche: (virk as { branche_tekst?: string } | null)?.branche_tekst ?? null },
  });

  // Hent ejendomme via ejf_ejerskab cache
  // BIZZ-1355: Filtrér på gyldig_fra/gyldig_til for historiske opslag
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ejfQuery = (admin as any)
    .from('ejf_ejerskab')
    .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
    .eq('ejer_cvr', cvr);

  if (asOfDate) {
    const isoDate = asOfDate.toISOString().slice(0, 10);
    ejfQuery = ejfQuery
      .lte('gyldig_fra', isoDate)
      .or(`gyldig_til.is.null,gyldig_til.gte.${isoDate}`);
  } else {
    ejfQuery = ejfQuery.eq('status', 'gældende');
  }

  const { data: ejfRows } = await ejfQuery.limit(100);

  for (const row of (ejfRows ?? []) as Array<{
    bfe_nummer: number;
    ejerandel_taeller: number | null;
    ejerandel_naevner: number | null;
  }>) {
    if (seenBfes.has(row.bfe_nummer) || aktiver.length >= MAX_AKTIVER) continue;
    seenBfes.add(row.bfe_nummer);
    aktiver.push({
      type: 'ejendom',
      label: `BFE ${row.bfe_nummer}`,
      bfe: row.bfe_nummer,
      rawData: {
        ejerandel_taeller: row.ejerandel_taeller,
        ejerandel_naevner: row.ejerandel_naevner,
        ejer_cvr: cvr,
      },
    });
  }

  // Hent datterselskaber via cvr_virksomhed_ejerskab cache
  // BIZZ-1355: Historisk filtrering på gyldig_fra/gyldig_til
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let subQuery = (admin as any)
    .from('cvr_virksomhed_ejerskab')
    .select('ejet_cvr, ejerandel_min')
    .eq('ejer_cvr', cvr);

  if (asOfDate) {
    const isoDate = asOfDate.toISOString().slice(0, 10);
    subQuery = subQuery
      .lte('gyldig_fra', isoDate)
      .or(`gyldig_til.is.null,gyldig_til.gte.${isoDate}`);
  } else {
    subQuery = subQuery.is('gyldig_til', null);
  }

  const { data: subRows } = await subQuery.limit(30);

  for (const sub of (subRows ?? []) as Array<{
    ejet_cvr: string;
    ejerandel_min: number | null;
  }>) {
    if (seenCvrs.has(sub.ejet_cvr) || aktiver.length >= MAX_AKTIVER) continue;

    // Hent virksomhedsinfo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: virk } = await (admin as any)
      .from('cvr_virksomhed')
      .select('navn, ansatte, branche_tekst, ophoert')
      .eq('cvr', sub.ejet_cvr)
      .maybeSingle();

    if (virk?.ophoert) continue;

    aktiver.push({
      type: 'virksomhed',
      label: virk?.navn ?? `CVR ${sub.ejet_cvr}`,
      cvr: sub.ejet_cvr,
      ansatte: virk?.ansatte ?? undefined,
      rawData: {
        branche: virk?.branche_tekst,
        ejerandel_pct: sub.ejerandel_min,
      },
    });

    // Rekursivt walk datterselskabets ejendomme
    await walkVirksomhed(admin, sub.ejet_cvr, aktiver, seenBfes, seenCvrs, depth + 1, asOfDate);
  }

  // Bestyrelsesposter (D&O detection)
  if (depth === 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: boardRows } = await (admin as any)
      .from('cvr_deltagerrelation')
      .select('deltager_enhedsnummer, type, virksomhed_cvr')
      .eq('virksomhed_cvr', cvr)
      .in('type', ['bestyrelse', 'direktion'])
      .is('gyldig_til', null)
      .limit(20);

    for (const br of (boardRows ?? []) as Array<{
      deltager_enhedsnummer: number;
      type: string;
      virksomhed_cvr: string;
    }>) {
      if (aktiver.length >= MAX_AKTIVER) break;
      aktiver.push({
        type: 'bestyrelsespost',
        label: `${br.type} i CVR ${br.virksomhed_cvr}`,
        cvr: br.virksomhed_cvr,
        rawData: {
          enhedsnummer: br.deltager_enhedsnummer,
          rolle: br.type,
        },
      });
    }
  }
}

/**
 * Walk en person: hent virksomheder + personligt ejede ejendomme.
 *
 * @param admin - Supabase admin client
 * @param enhedsNummer - Person enhedsNummer
 * @param aktiver - Mutable aktiver-array
 * @param seenBfes - Dedup set
 * @param seenCvrs - Dedup set
 */
async function walkPerson(
  admin: ReturnType<typeof createAdminClient>,
  enhedsNummer: string,
  aktiver: Aktiv[],
  seenBfes: Set<number>,
  seenCvrs: Set<string>
): Promise<void> {
  // Personens virksomheder via cvr_deltagerrelation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: relRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('virksomhed_cvr, type, ejerandel_pct')
    .eq('deltager_enhedsnummer', Number(enhedsNummer))
    .is('gyldig_til', null)
    .limit(50);

  const ownershipTypes = new Set(['register', 'reel_ejer', 'interessenter', 'indehaver']);

  for (const rel of (relRows ?? []) as Array<{
    virksomhed_cvr: string;
    type: string;
    ejerandel_pct: number | null;
  }>) {
    if (aktiver.length >= MAX_AKTIVER) break;

    // Bestyrelses/direktions-poster som aktiver (for D&O)
    if (rel.type === 'bestyrelse' || rel.type === 'direktion') {
      aktiver.push({
        type: 'bestyrelsespost',
        label: `${rel.type} i CVR ${rel.virksomhed_cvr}`,
        cvr: rel.virksomhed_cvr,
        rawData: { rolle: rel.type, ejerandel_pct: rel.ejerandel_pct },
      });
    }

    // Ejerskabs-relationer → walk virksomheden for ejendomme
    if (ownershipTypes.has(rel.type) || (rel.ejerandel_pct && rel.ejerandel_pct > 0)) {
      await walkVirksomhed(admin, rel.virksomhed_cvr, aktiver, seenBfes, seenCvrs, 1, null);
    }
  }

  // Personligt ejede ejendomme via ejf_ejerskab
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: personProps } = await (admin as any)
    .from('ejf_ejerskab')
    .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
    .eq('ejer_enheds_nummer', Number(enhedsNummer))
    .eq('status', 'gældende')
    .limit(50);

  for (const prop of (personProps ?? []) as Array<{
    bfe_nummer: number;
    ejerandel_taeller: number | null;
    ejerandel_naevner: number | null;
  }>) {
    if (seenBfes.has(prop.bfe_nummer) || aktiver.length >= MAX_AKTIVER) continue;
    seenBfes.add(prop.bfe_nummer);
    aktiver.push({
      type: 'ejendom',
      label: `BFE ${prop.bfe_nummer}`,
      bfe: prop.bfe_nummer,
      rawData: {
        ejerandel_taeller: prop.ejerandel_taeller,
        ejerandel_naevner: prop.ejerandel_naevner,
        personligt_ejet: true,
      },
    });
  }
}
