/**
 * BIZZ-2080: Menneskelæsbar begrundelse for hvorfor en police blev matchet
 * til et aktiv i forsikringsanalysen.
 *
 * Scoringen i `assetMatcher.ts` er deterministisk — hver score-værdi svarer
 * til præcis én match-regel pr. aktiv-type. Begrundelsen kan derfor afledes
 * af (type, score) uden at persistere ekstra data, og virker dermed også for
 * historiske analyser hvor kun `match_score` er gemt.
 *
 * VIGTIGT: Holdes i sync med score-værdierne i `assetMatcher.ts`
 * (scoreEjendom / scoreVirksomhed / scoreBil / scoreBestyrelsespost).
 */

/** Begrundelses-tabel pr. aktiv-type og score. [da, en] */
const BEGRUNDELSER: Record<string, Record<number, [string, string]>> = {
  ejendom: {
    100: ['BFE-nummer matcher policens ejendom', 'BFE number matches the policy property'],
    90: [
      'Adressen matcher policens forsikringssted præcist',
      'Address exactly matches the policy location',
    ],
    85: [
      'Adressen indgår i policens forsikringssted',
      'Address is contained in the policy location',
    ],
    82: [
      'Adressen matcher forsikringsstedet (etage/dør udeladt)',
      'Address matches the policy location (floor/door ignored)',
    ],
    80: [
      'Vejnavn og husnummer matcher forsikringsstedet',
      'Street name and house number match the policy location',
    ],
    // BIZZ-2096: nedarvet dækning via SFE-struktur (sfeStruktur.ts SFE_ARV_SCORE)
    75: [
      'Dækket via police på ejendommens SFE-adresse',
      'Covered via policy on the property’s SFE address',
    ],
    // BIZZ-2118: nedarvet dækning via søster-SFE i samme ejerlav med samme
    // ejer (sfeStruktur.ts SFE_KAEDE_SCORE)
    72: [
      'Dækket via SFE-kæden — søster-SFE i samme ejerlav med samme ejer',
      'Covered via the SFE chain — sister SFE in the same cadastral district with the same owner',
    ],
    70: [
      'Vejnavn matcher — husnummeret matcher delvist',
      'Street name matches — house number partially matches',
    ],
  },
  virksomhed: {
    100: ['CVR-nummer matcher policens forsikringstager', 'CVR number matches the policyholder'],
    // BIZZ-2120: selskabet står på policens parsede sikrede-liste
    95: [
      'CVR-nummer matcher policens sikrede-liste',
      'CVR number matches the policy’s insured-companies list',
    ],
    85: [
      'Selskabet står på policens sikrede-liste',
      'The company appears on the policy’s insured-companies list',
    ],
    75: ['Virksomhedsnavnet matcher forsikringstageren', 'Company name matches the policyholder'],
    70: [
      'Policen dækker erhvervsaktivitet (erhvervs-/ansvars-/driftspolice)',
      'Policy covers business activity (commercial/liability/operations policy)',
    ],
    60: [
      'Virksomhedsnavnet matcher delvist forsikringstageren',
      'Company name partially matches the policyholder',
    ],
  },
  bil: {
    100: [
      'Registreringsnummeret er nævnt i policen',
      'Registration number is mentioned in the policy',
    ],
  },
  bestyrelsespost: {
    100: ['D&O-police med matchende CVR', 'D&O policy with matching CVR'],
  },
};

/**
 * Returnér en menneskelæsbar begrundelse for et police-match.
 *
 * @param type - Aktiv-type ('ejendom' | 'virksomhed' | 'bil' | 'bestyrelsespost')
 * @param score - Persisteret match_score (0-100) eller null
 * @param da - true for dansk, false for engelsk
 * @returns Begrundelses-tekst, eller null hvis score mangler/ukendt
 */
export function getMatchBegrundelse(
  type: string,
  score: number | null | undefined,
  da: boolean
): string | null {
  if (score == null) return null;
  const entry = BEGRUNDELSER[type]?.[score];
  if (entry) return da ? entry[0] : entry[1];
  // Ukendt score-værdi (fx fremtidig regel-ændring) — generisk fallback
  return da ? 'Automatisk match' : 'Automatic match';
}
