/**
 * selectPrimaryOwner — vælger den "mest repræsentative" ejer fra EJF-listen
 * for et ejendomskort.
 *
 * Baggrund (BIZZ-460): /api/ejerskab returnerer alle ejerskab-noder for en BFE
 * — både CVR-selskabsejer og ejendePersonBegraenset (beneficial / begrænset
 * rettighedshaver). Indtil nu tog enrich-ruten `ejere[0]` blindt, så en
 * tilfældig person-node kunne overskygge selskabet der faktisk ejer 100%.
 *
 * Heuristik (mest præcis først):
 *   1. Filtrer indlysende ugyldige rækker (ingen identifikator).
 *   2. Sortér faldende på ejerandel (taeller/naevner som decimaltal).
 *      Ved 1/1 = 100% vinder den over person-noder med 0/0 eller null.
 *   3. Ved uafgjort: foretrækker CVR-ejer over person (company-context).
 *   4. Ved uafgjort: nyeste virkningFra først.
 *
 * Helper er eksporteret separat fra route så den kan testes uden at ramme
 * DAWA/CVR-opslag.
 */

export interface EjerCandidate {
  cvr: string | null;
  personNavn: string | null;
  ejerandel_taeller: number | null;
  ejerandel_naevner: number | null;
  virkningFra: string | null;
}

/**
 * Beregner ejerandel som ratio [0, 1]. Returnerer -1 for ugyldige/manglende
 * data så de sorterer sidst.
 */
function ejerandelRatio(e: EjerCandidate): number {
  if (e.ejerandel_taeller == null || e.ejerandel_naevner == null || e.ejerandel_naevner === 0) {
    return -1;
  }
  return e.ejerandel_taeller / e.ejerandel_naevner;
}

/**
 * Vælger primær ejer efter ovenstående heuristik.
 *
 * @param ejere - Rå liste fra /api/ejerskab response
 * @returns Primær ejer eller null når listen er tom
 */
export function selectPrimaryOwner<T extends EjerCandidate>(ejere: T[]): T | null {
  const valid = ejere.filter((e) => e.cvr || e.personNavn);
  if (valid.length === 0) return null;

  const sorted = [...valid].sort((a, b) => {
    const ra = ejerandelRatio(a);
    const rb = ejerandelRatio(b);
    if (ra !== rb) return rb - ra;

    // Samme ejerandel — CVR-ejer foretrukket (vi står på en virksomhedsside,
    // selskabet er det interessante, ikke en tilknyttet person-beneficiary).
    const aHasCvr = !!a.cvr;
    const bHasCvr = !!b.cvr;
    if (aHasCvr !== bHasCvr) return aHasCvr ? -1 : 1;

    // Samme ejerandel og samme type — nyeste virkningFra først.
    const va = a.virkningFra ?? '';
    const vb = b.virkningFra ?? '';
    if (va !== vb) return vb.localeCompare(va);

    return 0;
  });

  return sorted[0];
}
