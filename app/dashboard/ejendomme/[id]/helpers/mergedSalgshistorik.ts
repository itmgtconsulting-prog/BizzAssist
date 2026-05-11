/**
 * Merger EJF-salgshistorik med tinglysning-adkomster til en samlet liste.
 * Ekstraheret fra EjendomDetaljeClient.tsx for at reducere fil-størrelse.
 *
 * @module mergedSalgshistorik
 */

import type { HandelData } from '@/app/api/salgshistorik/route';
import type { TLEjer } from '@/app/api/tinglysning/summarisk/route';

/** En samlet handel der kan stamme fra EJF, tinglysning eller begge */
export interface MergedHandel {
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  /** Loesoerevardi fra EJF (inventar, maskiner m.m. der ikke er fast ejendom) */
  loesoeresum: number | null;
  /** Entreprisesum fra EJF (nybyggeri/ombygning inkluderet i koebet) */
  entreprisesum: number | null;
  koebsaftaleDato: string | null;
  overtagelsesdato: string | null;
  overdragelsesmaade: string | null;
  koeber: string | null;
  koebercvr: string | null;
  adkomstType: string | null;
  andel: string | null;
  tinglysningsdato: string | null;
  tinglysningsafgift: number | null;
  kilde: 'ejf' | 'tinglysning' | 'begge';
  /**
   * BIZZ-468: Struktureret liste af alle koebere i denne handel med hver
   * deres andel. Bruges af render-laget i stedet for den concatenerede
   * `koeber`-streng saa hver navn kan faa sin egen andel-suffix (ikke kun
   * den sidste). Tom liste = en koeber uden andel — brug fallback til
   * `koeber` + `andel`-felterne.
   */
  koebere?: { navn: string; cvr: string | null; andel: string | null }[];
  // BIZZ-481: Udvidede EJF_Ejerskifte felter
  /** True naar handlen er tinglyst med uopfyldte betingelser — vigtigt advarselsflag */
  betinget?: boolean | null;
  /** Frist for opfyldelse af betingelser (ISO 8601) */
  fristDato?: string | null;
  /** Officiel forretningshaendelse fra EJF — praecis klassificering i stedet for gaet */
  forretningshaendelse?: string | null;
  // BIZZ-480: Udvidede EJF_Handelsoplysninger felter
  /** Afstaaelsesdato — kan afvige fra overtagelsesdato */
  afstaaelsesdato?: string | null;
  /** Skoedetekst — beskrivelse fra skoedet */
  skoedetekst?: string | null;
}

/**
 * Merger EJF-salgshistorik med tinglysning-adkomster.
 * Matcher paa overtagelsesdato (plsminus 30 dage) for at samle data fra begge kilder.
 * Tinglysning bidrager med koebernavn, adkomsttype, andel og tinglysningsafgift.
 *
 * @param salgshistorik - EJF-handler fra /api/salgshistorik
 * @param tlEjere - Tinglysning adkomster fra /api/tinglysning/summarisk
 * @returns Sorteret liste af merged handler (nyeste foerst)
 */
export function buildMergedSalgshistorik(
  salgshistorik: HandelData[] | null,
  tlEjere: TLEjer[]
): MergedHandel[] {
  const merged: MergedHandel[] = [];
  const brugteTlIdx = new Set<number>();

  // Trin 1: Start med EJF-data og berig med tinglysning
  for (const h of salgshistorik ?? []) {
    const ejfDato = h.overtagelsesdato ?? h.koebsaftaleDato ?? '';
    let bestMatch: TLEjer | null = null;
    let bestIdx = -1;
    let bestDiff = Infinity;

    for (let i = 0; i < tlEjere.length; i++) {
      if (brugteTlIdx.has(i)) continue;
      const tlDato = tlEjere[i].overtagelsesdato ?? tlEjere[i].koebsaftaledato ?? '';
      if (!ejfDato || !tlDato) continue;
      const diff = Math.abs(new Date(ejfDato).getTime() - new Date(tlDato).getTime());
      if (diff < 30 * 24 * 60 * 60 * 1000 && diff < bestDiff) {
        bestDiff = diff;
        bestMatch = tlEjere[i];
        bestIdx = i;
      }
    }

    if (bestMatch && bestIdx >= 0) brugteTlIdx.add(bestIdx);

    // BIZZ-693: EJF har ofte null koebesum — fallback til Tinglysning-match
    merged.push({
      kontantKoebesum:
        h.kontantKoebesum ?? bestMatch?.kontantKoebesum ?? bestMatch?.koebesum ?? null,
      samletKoebesum: h.samletKoebesum ?? bestMatch?.iAltKoebesum ?? bestMatch?.koebesum ?? null,
      loesoeresum: h.loesoeresum,
      entreprisesum: h.entreprisesum,
      koebsaftaleDato: h.koebsaftaleDato,
      overtagelsesdato: h.overtagelsesdato,
      overdragelsesmaade: h.overdragelsesmaade,
      // BIZZ-685/693: prefer Tinglysning match (has adkomst-detaljer),
      // fall back til ejf-enriched navn fra /api/salgshistorik saa raekker
      // ikke laengere vises som tomme koebere naar Tinglysning ikke matcher.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      koeber: bestMatch?.navn ?? (h as any).koeber ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      koebercvr: bestMatch?.cvr ?? (h as any).koeberCvr ?? null,
      adkomstType: bestMatch?.adkomstType ?? null,
      andel: bestMatch?.andel ?? null,
      tinglysningsdato: bestMatch?.tinglysningsdato ?? null,
      tinglysningsafgift: bestMatch?.tinglysningsafgift ?? null,
      kilde: bestMatch ? 'begge' : 'ejf',
      // BIZZ-480 + BIZZ-481: Propager nye EJF-felter til UI-laget.
      betinget: h.betinget ?? null,
      fristDato: h.fristDato ?? null,
      forretningshaendelse: h.forretningshaendelse ?? null,
      afstaaelsesdato: h.afstaaelsesdato ?? null,
      skoedetekst: h.skoedetekst ?? null,
    });
  }

  // Trin 2: Tilfoej tinglysning-adkomster der ikke matchede EJF
  for (let i = 0; i < tlEjere.length; i++) {
    if (brugteTlIdx.has(i)) continue;
    const e = tlEjere[i];
    merged.push({
      kontantKoebesum: e.kontantKoebesum ?? e.koebesum,
      samletKoebesum: e.iAltKoebesum ?? e.koebesum,
      // Loesoere/entreprise comes only from EJF — not available in tinglysning records
      loesoeresum: null,
      entreprisesum: null,
      koebsaftaleDato: e.koebsaftaledato,
      overtagelsesdato: e.overtagelsesdato,
      overdragelsesmaade: e.adkomstType,
      koeber: e.navn,
      koebercvr: e.cvr,
      adkomstType: e.adkomstType,
      andel: e.andel,
      tinglysningsdato: e.tinglysningsdato,
      tinglysningsafgift: e.tinglysningsafgift,
      kilde: 'tinglysning',
    });
  }

  // BIZZ-444: Saml handler med samme dato til en linje (f.eks. 50%/50%
  // ejere der koeber sammen vises som en handel).
  // BIZZ-844: Group paa dato ALENE — tidligere (dato+sum) splittede raekker
  // naar Tinglysning-enrichment kun matchede en af flere EJF-rows paa samme
  // dato. Resulterede i "phantom"-raekker med samme dato men uden pris der
  // gav visningen "Brian Holm Larsen, Jakob Juul Rasmussen" ved siden af
  // en rigtig Jakob-raekke med pris. Ved merge foretraekkes den hoejeste
  // (non-null) sum saa prisen ikke gaar tabt.
  const grouped: MergedHandel[] = [];
  for (const h of merged) {
    const dato = h.overtagelsesdato ?? h.koebsaftaleDato ?? '';
    const existing = grouped.find((g) => {
      const gDato = g.overtagelsesdato ?? g.koebsaftaleDato ?? '';
      return gDato === dato && dato !== '';
    });
    if (existing) {
      // Behold hoejeste known sum (non-null) — Tinglysning-pris overskriver
      // EJF's null-pris.
      if (
        h.kontantKoebesum != null &&
        (existing.kontantKoebesum == null || h.kontantKoebesum > existing.kontantKoebesum)
      ) {
        existing.kontantKoebesum = h.kontantKoebesum;
      }
      if (
        h.samletKoebesum != null &&
        (existing.samletKoebesum == null || h.samletKoebesum > existing.samletKoebesum)
      ) {
        existing.samletKoebesum = h.samletKoebesum;
      }
      if (h.tinglysningsdato && !existing.tinglysningsdato) {
        existing.tinglysningsdato = h.tinglysningsdato;
      }
      if (h.tinglysningsafgift != null && existing.tinglysningsafgift == null) {
        existing.tinglysningsafgift = h.tinglysningsafgift;
      }
    }
    if (existing && h.koeber) {
      // BIZZ-468: Build a structured koebere[] — each buyer keeps sin egen
      // andel. Undgaar den gamle string-concat-bug hvor kun sidste koeber
      // havde andel-suffix fordi foerste koebers `andel` var null paa
      // existing-raekken selvom den faktisk var kendt paa en senere raekke.
      if (!existing.koebere || existing.koebere.length === 0) {
        // Seed koebere med existing's single buyer foerst
        existing.koebere = [
          { navn: existing.koeber ?? '', cvr: existing.koebercvr, andel: existing.andel },
        ];
      }
      // BIZZ-844: Skip hvis samme navn+cvr allerede er i koebere (dedup
      // naar EJF + Tinglysning returnerer samme person for samme handel).
      const dupKey = `${h.koeber}__${h.koebercvr ?? ''}`;
      const alreadyPresent = existing.koebere.some((k) => `${k.navn}__${k.cvr ?? ''}` === dupKey);
      if (!alreadyPresent) {
        existing.koebere.push({ navn: h.koeber, cvr: h.koebercvr, andel: h.andel });
      }
      // Rebuild koeber-strengen — inkluder andel per navn hvis minimum et
      // navn har en kendt andel. Hvis INGEN har andel, vis bare navnene.
      const anyAndel = existing.koebere.some((k) => k.andel);
      existing.koeber = existing.koebere
        .map((k) => (anyAndel && k.andel ? `${k.navn} (${k.andel})` : k.navn))
        .join(', ');
      // Naar flere koebere med andel: ryd top-level andel (vises inline pr navn)
      if (anyAndel) existing.andel = null;
    } else {
      grouped.push({ ...h });
    }
  }

  // Sorter nyeste foerst
  grouped.sort((a, b) => {
    const da2 = a.overtagelsesdato ?? a.koebsaftaleDato ?? '';
    const db = b.overtagelsesdato ?? b.koebsaftaleDato ?? '';
    return db.localeCompare(da2);
  });

  return grouped;
}
