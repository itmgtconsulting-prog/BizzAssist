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
 * BIZZ-2103: Minimum ejerandel (%) for at et ejet selskab regnes som
 * koncern-selskab og walkes som datterselskab. Minoritetsposter (fx 5%)
 * og stale cache-rækker med ejerandel NULL må ikke trække en fuld
 * gap-analyse af et fremmed selskab ind i kundens koncern.
 */
const KONCERN_EJERANDEL_MIN = 50;

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

  // BIZZ-1775: Berig ejendoms-labels med adresser fra bfe_adresse_cache
  const bfeAktiver = aktiver.filter(
    (a) => a.type === 'ejendom' && a.bfe && a.label.startsWith('BFE ')
  );
  if (bfeAktiver.length > 0) {
    try {
      const bfes = bfeAktiver.map((a) => a.bfe!);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: adresser } = await (admin as any)
        .from('bfe_adresse_cache')
        .select('bfe_nummer, adresse, etage, doer, postnr, postnrnavn')
        .in('bfe_nummer', bfes.slice(0, 100));
      if (adresser) {
        const addrMap = new Map(
          (adresser as Array<Record<string, unknown>>).map((a) => {
            const parts = [a.adresse as string];
            if (a.etage) parts.push(`${a.etage}.`);
            if (a.doer) parts[parts.length - 1] += ` ${a.doer}`;
            if (a.postnr) parts.push(`${a.postnr} ${a.postnrnavn ?? ''}`);
            return [a.bfe_nummer as number, parts.join(', ').trim()];
          })
        );
        for (const a of bfeAktiver) {
          const addr = addrMap.get(a.bfe!);
          if (addr) a.label = addr;
        }
      }
    } catch {
      /* address enrichment non-fatal */
    }
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
 * @param parentCvr - BIZZ-2102: CVR på moderselskabet (undefined for roden)
 * @param ejerandelPct - BIZZ-2102: Moderselskabets ejerandel i procent (null = ukendt)
 */
async function walkVirksomhed(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string,
  aktiver: Aktiv[],
  seenBfes: Set<number>,
  seenCvrs: Set<string>,
  depth: number,
  asOfDate: Date | null,
  parentCvr?: string,
  ejerandelPct?: number | null
): Promise<void> {
  if (seenCvrs.has(cvr) || depth > 3 || aktiver.length >= MAX_AKTIVER) return;
  seenCvrs.add(cvr);

  // BIZZ-1443: Tilføj virksomheden selv som aktiv (for ansvarsforsikring-matching)
  // BIZZ-1840: Hent også virksomhedsform for FFO/andelsbolig-detection
  // BIZZ-2102: Selv-pushet er nu det ENESTE sted virksomheds-aktiver oprettes —
  // tidligere pushede parent-loopet OGSÅ datterselskabet (dublet-bug).
  const { data: virk } = await (admin as ReturnType<typeof createAdminClient>)
    .from('cvr_virksomhed')
    .select('navn, ansatte_aar, branche_tekst, virksomhedsform, ophoert')
    .eq('cvr', cvr)
    .maybeSingle();

  const virkRow = virk as {
    navn?: string;
    ansatte_aar?: number | null;
    branche_tekst?: string | null;
    virksomhedsform?: string;
    ophoert?: string | null;
  } | null;

  // BIZZ-2101: Ophørte datterselskaber walkes ikke (kunden selv ved depth 0 vises altid)
  if (depth > 0 && virkRow?.ophoert) return;

  aktiver.push({
    type: 'virksomhed',
    label: virkRow?.navn ?? `CVR ${cvr}`,
    cvr,
    ansatte: virkRow?.ansatte_aar ?? undefined,
    rawData: {
      branche: virkRow?.branche_tekst ?? null,
      // BIZZ-2102: Hierarki-metadata til koncern-sortering i UI
      depth,
      parent_cvr: parentCvr ?? null,
      ejerandel_pct: ejerandelPct ?? null,
    },
  });

  // BIZZ-1646 + BIZZ-1840: Detect ejer-/andelsforening
  // Matcher FFO-form, "forening" i virksomhedsform, og A/B i virksomhedsform
  // eller forenings-keywords i virksomhedsnavnet (fanger A/B, E/F, andelsbolig).
  const virkForm = (virk as { virksomhedsform?: string } | null)?.virksomhedsform ?? '';
  const virkNavn = (virk as { navn?: string } | null)?.navn ?? '';
  const formLower = virkForm.toLowerCase();
  const navnLower = virkNavn.toLowerCase();
  const isFFO =
    virkForm.toUpperCase().includes('FFO') ||
    formLower.includes('forening') ||
    formLower === 'a/b' ||
    navnLower.includes('ejerforening') ||
    navnLower.includes('andelsbolig') ||
    navnLower.startsWith('a/b ') ||
    navnLower.startsWith('e/f ') ||
    navnLower.includes('boligforening');

  if (isFFO && depth === 0) {
    // E/F: Hent administrerede ejendomme via ejerforholdskode 30 i bbr_ejendom_status
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: bbrRows } = await (admin as any)
        .from('bbr_ejendom_status')
        .select('bfe_nummer, samlet_boligareal, grundareal, adgangsadresse_id')
        .eq('ejerforholdskode', '30')
        .limit(50);

      // Alternativ: EJF lookup direkte
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: ejfAll } = await (admin as any)
        .from('ejf_ejerskab')
        .select('bfe_nummer')
        .eq('ejer_cvr', cvr)
        .eq('status', 'gældende')
        .limit(100);

      const ejfBfes = new Set((ejfAll ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer));

      for (const row of (bbrRows ?? []) as Array<{
        bfe_nummer: number;
        samlet_boligareal: number | null;
        grundareal: number | null;
      }>) {
        if (!ejfBfes.has(row.bfe_nummer)) continue;
        if (seenBfes.has(row.bfe_nummer) || aktiver.length >= MAX_AKTIVER) continue;
        seenBfes.add(row.bfe_nummer);
        aktiver.push({
          type: 'ejendom',
          label: `BFE ${row.bfe_nummer}`,
          bfe: row.bfe_nummer,
          rawData: { ejerforening: true, boligareal: row.samlet_boligareal },
        });
      }

      // Hvis EJF har direkte poster, brug dem også
      for (const row of (ejfAll ?? []) as Array<{ bfe_nummer: number }>) {
        if (seenBfes.has(row.bfe_nummer) || aktiver.length >= MAX_AKTIVER) continue;
        seenBfes.add(row.bfe_nummer);
        aktiver.push({
          type: 'ejendom',
          label: `BFE ${row.bfe_nummer}`,
          bfe: row.bfe_nummer,
          rawData: { ejerforening: true },
        });
      }

      // BIZZ-1691: Hent administrerede ejendomme fra ejf_administrator
      // Ejerforeningen administrerer typisk ALLE EL'er i bygningen,
      // ikke kun de 6 kælder-EL'er den direkte ejer.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: adminRows } = await (admin as any)
          .from('ejf_administrator')
          .select('bfe_nummer')
          .eq('virksomhed_cvr', cvr)
          .eq('status', 'gældende')
          .limit(200);

        for (const row of (adminRows ?? []) as Array<{ bfe_nummer: number }>) {
          if (seenBfes.has(row.bfe_nummer) || aktiver.length >= MAX_AKTIVER) continue;
          seenBfes.add(row.bfe_nummer);
          aktiver.push({
            type: 'ejendom',
            label: `BFE ${row.bfe_nummer}`,
            bfe: row.bfe_nummer,
            rawData: { ejerforening: true, administreret: true },
          });
        }
      } catch {
        /* ejf_administrator lookup non-fatal */
      }

      // BIZZ-1862: Historisk ejerskab FØRST — foreninger der solgte SFE men
      // stadig administrerer bygningen har kun historisk ejerskab. Disse SFE-BFEs
      // skal være i seenBfes FØR SFE-expansion så matrikel-lookup finder dem.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: histRows } = await (admin as any)
          .from('ejf_ejerskab')
          .select('bfe_nummer')
          .eq('ejer_cvr', cvr)
          .eq('status', 'historisk')
          .limit(100);

        for (const row of (histRows ?? []) as Array<{ bfe_nummer: number }>) {
          if (seenBfes.has(row.bfe_nummer) || aktiver.length >= MAX_AKTIVER) continue;
          seenBfes.add(row.bfe_nummer);
          aktiver.push({
            type: 'ejendom',
            label: `BFE ${row.bfe_nummer}`,
            bfe: row.bfe_nummer,
            rawData: { ejerforening: true, historisk: true },
          });
        }
      } catch {
        /* historisk ejerskab lookup non-fatal */
      }

      // BIZZ-1851: SFE → ejerlejligheder udfoldning via matrikel.
      // Bruger DAWA jordstykke til at finde præcis matrikel for SFE-BFE,
      // derefter alle lejligheder (adresser med etage) på den matrikel.
      // Matrikel-afgrænsning sikrer at kun foreningens egne lejligheder
      // inkluderes — gadenavn-søgning er for bred (fanger andre bygninger).
      try {
        const sfeBfes = [...seenBfes];

        for (const sfeBfe of sfeBfes.slice(0, 20)) {
          try {
            // Find matrikel via DAWA jordstykke
            const jordRes = await fetch(
              `https://api.dataforsyningen.dk/jordstykker?bfenummer=${sfeBfe}&format=json`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (!jordRes.ok) continue;
            const jordstykker = (await jordRes.json()) as Array<{
              ejerlav?: { kode?: number };
              matrikelnr?: string;
            }>;
            const ejerlav = jordstykker[0]?.ejerlav?.kode;
            const matr = jordstykker[0]?.matrikelnr;
            if (!ejerlav || !matr) continue;

            // Find alle adresser på matriklen — kun lejligheder (med etage)
            const adrRes = await fetch(
              `https://api.dataforsyningen.dk/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=500`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (!adrRes.ok) continue;
            const adresser = (await adrRes.json()) as Array<{
              vejnavn: string;
              husnr: string;
              etage: string | null;
              dør: string | null;
              postnr: string;
              postnrnavn: string;
            }>;

            const lejligheder = adresser.filter((a) => a.etage);

            // Match mod bfe_adresse_cache for BFE-numre
            const gadenavne = [...new Set(lejligheder.map((a) => a.vejnavn))];
            const postnr = lejligheder[0]?.postnr;
            if (!postnr || gadenavne.length === 0) {
              // Ingen lejligheder fundet på matrikel — intet at udfolde
              continue;
            }

            // Hent alle cached BFEs på samme gader+postnr med etage
            const cachedBfeSet = new Set<number>();
            for (const gade of gadenavne.slice(0, 10)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: cacheRows } = await (admin as any)
                .from('bfe_adresse_cache')
                .select('bfe_nummer, adresse')
                .ilike('adresse', `${gade}%`)
                .eq('postnr', postnr)
                .not('etage', 'is', null)
                .limit(500);

              for (const row of (cacheRows ?? []) as Array<{
                bfe_nummer: number;
                adresse: string;
              }>) {
                // Verificér at adressen faktisk er på denne matrikel
                // ved at matche mod DAWA-adresserne (vejnavn + husnr)
                const matchesMatrikel = lejligheder.some((l) =>
                  row.adresse.startsWith(`${l.vejnavn} ${l.husnr}`)
                );
                if (matchesMatrikel) cachedBfeSet.add(row.bfe_nummer);
              }
            }

            for (const bfe of cachedBfeSet) {
              if (seenBfes.has(bfe) || aktiver.length >= MAX_AKTIVER) continue;
              seenBfes.add(bfe);
              aktiver.push({
                type: 'ejendom',
                label: `BFE ${bfe}`,
                bfe,
                rawData: { ejerforening: true, sfeExpanded: true },
              });
            }

            // For lejligheder IKKE i cache: tilføj direkte fra DAWA-data
            // (bfe=0 men med adresse — forsikrings-match kan stadig ske på adresse)
            if (cachedBfeSet.size < lejligheder.length) {
              const cachedAddresses = new Set<string>();
              for (const bfe of cachedBfeSet) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { data: row } = await (admin as any)
                  .from('bfe_adresse_cache')
                  .select('adresse, etage, doer')
                  .eq('bfe_nummer', bfe)
                  .maybeSingle();
                if (row) {
                  cachedAddresses.add(
                    `${(row as { adresse: string }).adresse}|${(row as { etage: string | null }).etage ?? ''}|${(row as { doer: string | null }).doer ?? ''}`
                  );
                }
              }

              for (const l of lejligheder) {
                const key = `${l.vejnavn} ${l.husnr}|${l.etage ?? ''}|${l.dør ?? ''}`;
                if (cachedAddresses.has(key)) continue;
                if (aktiver.length >= MAX_AKTIVER) break;
                aktiver.push({
                  type: 'ejendom',
                  label: `${l.vejnavn} ${l.husnr}, ${l.etage}.${l.dør ?? ''}, ${l.postnr} ${l.postnrnavn}`,
                  bfe: 0,
                  adresse: `${l.vejnavn} ${l.husnr}, ${l.etage}.${l.dør ?? ''}, ${l.postnr} ${l.postnrnavn}`,
                  rawData: { ejerforening: true, sfeExpanded: true, dawaResolved: true },
                });
              }
            }
          } catch {
            /* individual SFE expansion non-fatal */
          }
        }
      } catch {
        /* SFE expansion non-fatal */
      }

      // BIZZ-1829: AI-baseret resolve af yderligere ejendomme
      // Finder kandidater på samme gader og filtrerer til høj confidence (>0.8)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: aiCache } = await (admin as any)
          .from('ai_ejf_ejendom_cache')
          .select('candidates, created_at')
          .eq('cvr', cvr)
          .maybeSingle();

        if (aiCache?.candidates && Array.isArray(aiCache.candidates)) {
          const aiAge = Date.now() - new Date(aiCache.created_at).getTime();
          // Kun brug cache < 24t gammel
          if (aiAge < 24 * 60 * 60 * 1000) {
            for (const c of aiCache.candidates as Array<{
              bfeNummer: number;
              adresse: string;
              confidence: string;
            }>) {
              // Kun høj confidence i gap-analyse
              if (c.confidence !== 'high') continue;
              if (seenBfes.has(c.bfeNummer) || aktiver.length >= MAX_AKTIVER) continue;
              seenBfes.add(c.bfeNummer);
              aktiver.push({
                type: 'ejendom',
                label: c.adresse || `BFE ${c.bfeNummer}`,
                bfe: c.bfeNummer,
                rawData: { ejerforening: true, aiForeslaaet: true },
              });
            }
          }
        }
      } catch {
        /* AI cache lookup non-fatal */
      }
      // BIZZ-1851: Fjern SFE/hovedejendom-BFEs der er erstattet af
      // udfolded lejligheder. Når SFE-expansion fandt lejligheder,
      // skal SFE-BFE'en selv og AI-kandidater uden etage ikke tælles
      // med som separate aktiver — de er "containere", ikke enheder.
      // Detect SFE-expansion: enten BFE=0 (DAWA-resolved) eller
      // adresser med etage-indikator i label (", st", ", 1 ", ", kl")
      const ejendomAktiver = aktiver.filter((a) => a.type === 'ejendom');
      const hasExpandedLejligheder =
        ejendomAktiver.some((a) => a.bfe === 0) ||
        ejendomAktiver.filter((a) => /,\s*(?:st|kl|\d)\s/.test(a.label)).length > 3;
      if (hasExpandedLejligheder) {
        // BFEs med bfe > 0 der IKKE er lejligheder → kandidater for fjernelse
        const bfesToCheck = new Set<number>();
        for (const a of ejendomAktiver) {
          if (a.bfe && a.bfe > 0) {
            bfesToCheck.add(a.bfe);
          }
        }
        // Tjek om disse BFEs har etage i cache — hvis ikke, er de SFE/hovedejendomme
        if (bfesToCheck.size > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: etageRows } = await (admin as any)
            .from('bfe_adresse_cache')
            .select('bfe_nummer, etage')
            .in('bfe_nummer', [...bfesToCheck]);
          // BFEs uden etage ELLER ikke i cache → SFE/hovedejendomme
          const bfesWithEtage = new Set<number>();
          for (const row of (etageRows ?? []) as Array<{
            bfe_nummer: number;
            etage: string | null;
          }>) {
            if (row.etage) bfesWithEtage.add(row.bfe_nummer);
          }
          const bfesWithoutEtage = new Set<number>();
          for (const bfe of bfesToCheck) {
            if (!bfesWithEtage.has(bfe)) bfesWithoutEtage.add(bfe);
          }
          // Fjern SFE/hovedejendom-aktiver (uden etage) der nu er dækket af lejligheder
          for (let i = aktiver.length - 1; i >= 0; i--) {
            if (
              aktiver[i].type === 'ejendom' &&
              aktiver[i].bfe &&
              bfesWithoutEtage.has(aktiver[i].bfe!)
            ) {
              aktiver.splice(i, 1);
            }
          }
          // Behold fjernede BFEs i seenBfes så de ikke re-tilføjes
          // af efterfølgende ejf_ejerskab query
        }
      }
    } catch {
      /* non-fatal — fallback til standard flow */
    }
  }

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
  // BIZZ-2103: Kun kontrollerende ejerskab (>= 50%) walkes som koncern —
  // .gte ekskluderer samtidig rækker med ejerandel_min NULL (stale rækker
  // fra cron'en uden aktiv EJERANDEL_PROCENT, fx historiske ejere).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let subQuery = (admin as any)
    .from('cvr_virksomhed_ejerskab')
    .select('ejet_cvr, ejerandel_min')
    .eq('ejer_cvr', cvr)
    .gte('ejerandel_min', KONCERN_EJERANDEL_MIN);

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
    // BIZZ-2103: Defensiv guard mod stale cache-rækker (ejerandel NULL) og
    // minoritetsposter, hvis querien af en eller anden grund returnerer dem.
    if (sub.ejerandel_min == null || sub.ejerandel_min < KONCERN_EJERANDEL_MIN) continue;

    // BIZZ-2102: Rekursivt walk — walkVirksomhed laver selv-push med
    // navn/ansatte/ophørt-filter (BIZZ-2101) og hierarki-metadata.
    // Tidligere pushede vi datterselskabet HER også → dubletter i UI.
    await walkVirksomhed(
      admin,
      sub.ejet_cvr,
      aktiver,
      seenBfes,
      seenCvrs,
      depth + 1,
      asOfDate,
      cvr,
      sub.ejerandel_min
    );
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
