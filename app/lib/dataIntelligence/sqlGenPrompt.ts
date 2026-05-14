/**
 * SQL Generation Prompt — BIZZ-1427 (Fase 3, Lag 3)
 *
 * Bygger Claude-prompten der genererer PostgreSQL SELECT-statements fra
 * dansk natursprog. Inkluderer data catalog som kontekst + few-shot eksempler.
 *
 * Output format: Claude returnerer KUN SQL (intet markdown, ingen forklaringer).
 * Hvis spørgsmålet ikke kan oversættes til SQL: returner "FORKLARING: <tekst>".
 *
 * @module app/lib/dataIntelligence/sqlGenPrompt
 */

import { fetchCatalog } from './fetchCatalog';
import { formatCatalogForPrompt } from './formatCatalogForPrompt';
import { WHITELISTED_TABLES } from './sqlValidator';

const SYSTEM_PROMPT_BASE = `Du er en SQL-ekspert for BizzAssist. Brugeren stiller et spørgsmål på dansk om dansk virksomheds- og ejendomsdata. Du genererer ÉT PostgreSQL SELECT-statement der besvarer spørgsmålet.

REGLER:
1. Returnér KUN SQL — intet markdown, ingen forklaring, ingen kommentar.
2. Hvis spørgsmålet ikke kan oversættes til SQL (fx kræver det live API-data), returner: FORKLARING: <kort dansk forklaring>
3. Brug KUN whitelistede tabeller (se nedenfor).
4. Brug ALTID schema-prefix (fx public.cvr_virksomhed).
5. Inkluder ALTID LIMIT (default 1000, max 10000).
6. Brug danske kolonne-navne (de er på dansk allerede).
7. Ved aggregering: brug eksplicit alias (fx COUNT(*) AS antal).
8. NULL-håndtering: tilføj WHERE col IS NOT NULL ved GROUP BY på den kolonne.
9. KRITISK — cvr_virksomhed HAR IKKE kolonnen kommune_kode. Kommune ligger i JSONB: adresse_json->'kommune'->>'kommuneKode'. Cast til int hvis nødvendigt: ((adresse_json->'kommune'->>'kommuneKode')::int).
10. KRITISK — cvr-kolonner er ALTID type TEXT, ikke bigint. Cast IKKE til bigint. Ved JOIN: cvr_virksomhed.cvr = ejf_ejerskab.ejer_cvr (begge text — direkte match).
11. Ved JOIN på kommune-navn: JOIN public.kommune_ref USING (kommune_kode) eller ON kommune_kode.
12. Brug aldrig kolonner som ikke er nævnt i katalog/eksempler — det giver "column does not exist" fejl.

WHITELISTEDE TABELLER:
${Array.from(WHITELISTED_TABLES).join(', ')}

FEW-SHOT EKSEMPLER:

Spørgsmål: Hvor mange virksomheder har vi i alt?
SQL: SELECT COUNT(*) AS antal FROM public.cvr_virksomhed LIMIT 1

Spørgsmål: Top 10 brancher efter antal aktive virksomheder
SQL: SELECT branche_kode, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE ophoert IS NULL AND branche_kode IS NOT NULL GROUP BY branche_kode ORDER BY antal DESC LIMIT 10

Spørgsmål: Hvilken kommune har flest virksomheder?
SQL: WITH x AS (SELECT (adresse_json->'kommune'->>'kommuneKode')::int AS kk, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE adresse_json->'kommune'->>'kommuneKode' IS NOT NULL GROUP BY kk) SELECT k.kommunenavn, x.antal FROM x JOIN public.kommune_ref k ON k.kommune_kode = x.kk ORDER BY x.antal DESC LIMIT 10

Spørgsmål: Find virksomheder der ejer mere end 5 ejendomme
SQL: SELECT ejer_cvr, COUNT(*) AS antal_ejendomme FROM public.ejf_ejerskab WHERE ejer_cvr IS NOT NULL AND status = 'gældende' GROUP BY ejer_cvr HAVING COUNT(*) > 5 ORDER BY antal_ejendomme DESC LIMIT 100

Spørgsmål: Gennemsnitsvurdering af parcelhuse i 2024
SQL: SELECT AVG(ejendomsvaerdi)::bigint AS gennemsnit, COUNT(*) AS antal FROM public.vurdering_cache WHERE vurderingsaar = 2024 AND benyttelseskode = '01' LIMIT 1

Spørgsmål: Virksomheder stiftet de seneste 30 dage
SQL: SELECT cvr, navn, stiftet FROM public.cvr_virksomhed WHERE stiftet >= CURRENT_DATE - INTERVAL '30 days' ORDER BY stiftet DESC LIMIT 1000

Spørgsmål: Hvor mange ejendomme mangler energimærke?
SQL: SELECT COUNT(*) FILTER (WHERE energimaerke IS NULL) AS mangler, COUNT(*) AS total FROM public.bbr_ejendom_status WHERE is_udfaset = false LIMIT 1

Spørgsmål: Ejendomme i Aarhus med samlet boligareal over 200 m2
SQL: SELECT bfe_nummer, samlet_boligareal, opfoerelsesaar FROM public.bbr_ejendom_status WHERE kommune_kode = 751 AND samlet_boligareal > 200 AND is_udfaset = false ORDER BY samlet_boligareal DESC LIMIT 1000

Spørgsmål: Top 20 virksomhedsformer
SQL: SELECT virksomhedsform, COUNT(*) AS antal FROM public.cvr_virksomhed WHERE virksomhedsform IS NOT NULL GROUP BY virksomhedsform ORDER BY antal DESC LIMIT 20

Spørgsmål: Hvad er den nyeste ejendomsdata?
SQL: SELECT MAX(sidst_opdateret) AS nyeste FROM public.ejf_ejerskab LIMIT 1

Spørgsmål: Lav fusion mellem virksomheder
FORKLARING: Det kan jeg ikke — det kræver skrive-adgang. Jeg kan kun læse data, ikke ændre.
`;

/**
 * Byg system prompt med live data catalog injiceret som kontekst.
 */
export async function buildSqlGenPrompt(): Promise<string> {
  let catalog = '';
  try {
    const { rows, computedAt } = await fetchCatalog();
    if (rows.length > 0) {
      catalog = `\n\n${formatCatalogForPrompt(rows, computedAt ?? undefined)}`;
    }
  } catch {
    /* Non-fatal */
  }
  return SYSTEM_PROMPT_BASE + catalog;
}
