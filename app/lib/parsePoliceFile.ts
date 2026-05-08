/**
 * Parser for forsikrings-policelister fra CSV og Excel-filer.
 *
 * BIZZ-1225: Understøtter CSV (komma/semikolon-separeret) og Excel (.xlsx).
 * Auto-detecter kolonnenavne via fuzzy matching og normaliserer
 * forsikringstyper til standardiseret enum.
 *
 * @module app/lib/parsePoliceFile
 */

/** Standardiserede forsikringstyper */
export type ForsikringsType =
  | 'husforsikring'
  | 'indboforsikring'
  | 'bilforsikring'
  | 'erhvervsforsikring'
  | 'ansvarsforsikring'
  | 'bestyrelsesansvar'
  | 'arbejdsskadeforsikring'
  | 'rejseforsikring'
  | 'livsforsikring'
  | 'bygningsforsikring'
  | 'andet';

/** En parsed forsikringspolice */
export interface ParsedPolice {
  /** Normaliseret forsikringstype */
  type: ForsikringsType;
  /** Rå type-tekst fra kildefilen */
  rawType: string;
  /** Dækningssum i DKK (null hvis ikke angivet) */
  daekningssum: number | null;
  /** Forsikringsselskab */
  selskab: string | null;
  /** Forsikringsobjekt (adresse, reg.nr, etc.) */
  objekt: string | null;
  /** Policenummer */
  policenummer: string | null;
  /** Udløbsdato (ISO) */
  udloebsdato: string | null;
  /** Kilde-linje i filen (til fejl-reference) */
  linje: number;
}

/** Resultat fra parsing */
export interface ParsePoliceResult {
  policer: ParsedPolice[];
  fejl: Array<{ linje: number; besked: string }>;
  kolonner: string[];
}

// ─── Fuzzy column matching ──────────────────────────────────────────────────

/** Kolonne-mappings: nøgle = vores felt, værdier = mulige kolonnenavne */
const COLUMN_PATTERNS: Record<string, RegExp> = {
  type: /^(police)?type$|^forsikring(stype)?$|^type$|^kategori$|^art$/i,
  daekningssum:
    /^(d[aæ]knings?)?sum$|^d[aæ]kning(sbel[oø]b)?$|^bel[oø]b$|^forsikringssum$|d[aæ]kningsbel[oø]b/i,
  selskab: /^selskab$|^forsikringsselskab$|^udbyder$|^firma$/i,
  objekt: /^objekt$|^adresse$|^registrering(snummer)?$|^reg\.?nr\.?$|^genstand$/i,
  policenummer: /^police(nummer)?$|^police.?nr\.?$|^aftale(nummer)?$/i,
  udloebsdato: /^udl[oø]b(sdato)?$|^slutdato$|^fornyelse(sdato)?$|^g[yæ]ldig.?til$/i,
};

/**
 * Matcher kolonnenavne fra filen til vores felter via fuzzy regex.
 *
 * @param headers - Rå kolonnenavne fra filen
 * @returns Map fra felt-navn til kolonne-index
 */
function matchColumns(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const normalized = headers.map((h) =>
    h.trim().toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
  );

  for (const [field, pattern] of Object.entries(COLUMN_PATTERNS)) {
    for (let i = 0; i < normalized.length; i++) {
      if (pattern.test(normalized[i]) || pattern.test(headers[i].trim())) {
        map.set(field, i);
        break;
      }
    }
  }
  return map;
}

// ─── Type normalisation ─────────────────────────────────────────────────────

/** Mapper rå forsikringstype-tekst til standardiseret enum */
const TYPE_PATTERNS: Array<{ pattern: RegExp; type: ForsikringsType }> = [
  { pattern: /hus|ejendom|villa|bolig(?!ind)/i, type: 'husforsikring' },
  { pattern: /bygning/i, type: 'bygningsforsikring' },
  { pattern: /indbo|løsøre|hjemme/i, type: 'indboforsikring' },
  { pattern: /bil|motor|k[oø]ret[oø]j|kasko/i, type: 'bilforsikring' },
  { pattern: /bestyrelse|d&o|director/i, type: 'bestyrelsesansvar' },
  { pattern: /arbejdsskade|ulykke/i, type: 'arbejdsskadeforsikring' },
  { pattern: /ansvar/i, type: 'ansvarsforsikring' },
  { pattern: /erhverv|virksomhed|drift/i, type: 'erhvervsforsikring' },
  { pattern: /rejse|udland/i, type: 'rejseforsikring' },
  { pattern: /liv|d[oø]d|pension/i, type: 'livsforsikring' },
];

/**
 * Normaliserer en rå forsikringstype-tekst til standardiseret enum.
 *
 * @param raw - Rå type-tekst fra kildefilen
 * @returns Normaliseret ForsikringsType
 */
export function normaliserForsikringstype(raw: string): ForsikringsType {
  for (const { pattern, type } of TYPE_PATTERNS) {
    if (pattern.test(raw)) return type;
  }
  return 'andet';
}

// ─── CSV parser ─────────────────────────────────────────────────────────────

/**
 * Parser CSV-tekst (komma eller semikolon-separeret) til policeliste.
 *
 * @param text - Rå CSV-tekst
 * @returns ParsePoliceResult
 */
export function parseCsv(text: string): ParsePoliceResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return {
      policer: [],
      fejl: [{ linje: 1, besked: 'Filen er tom eller mangler header' }],
      kolonner: [],
    };
  }

  // Auto-detect separator (semikolon vs komma)
  const headerLine = lines[0];
  const sep = headerLine.includes(';') ? ';' : ',';
  const headers = headerLine.split(sep).map((h) => h.trim().replace(/^["']|["']$/g, ''));
  const colMap = matchColumns(headers);

  if (!colMap.has('type')) {
    return {
      policer: [],
      fejl: [{ linje: 1, besked: 'Kunne ikke finde kolonne for forsikringstype' }],
      kolonner: headers,
    };
  }

  const policer: ParsedPolice[] = [];
  const fejl: Array<{ linje: number; besked: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    const typeIdx = colMap.get('type')!;
    const rawType = cols[typeIdx]?.trim();

    if (!rawType) {
      fejl.push({ linje: i + 1, besked: 'Tom forsikringstype' });
      continue;
    }

    const sumIdx = colMap.get('daekningssum');
    let daekningssum: number | null = null;
    if (sumIdx != null && cols[sumIdx]) {
      // Fjern alt undtagen tal, punktum og komma
      let sumStr = cols[sumIdx].replace(/[^0-9.,]/g, '');
      // Dansk tusind-separator: 3.500.000 → 3500000
      // Tjek om punktum bruges som tusind-separator (>1 punktum ELLER punktum fulgt af 3 cifre)
      if ((sumStr.match(/\./g) ?? []).length > 1 || /\.\d{3}($|[.,])/.test(sumStr)) {
        sumStr = sumStr.replace(/\./g, '').replace(',', '.');
      } else {
        sumStr = sumStr.replace(',', '.');
      }
      const parsed = parseFloat(sumStr);
      if (!isNaN(parsed) && parsed > 0) daekningssum = parsed;
    }

    policer.push({
      type: normaliserForsikringstype(rawType),
      rawType,
      daekningssum,
      selskab: colMap.has('selskab') ? cols[colMap.get('selskab')!] || null : null,
      objekt: colMap.has('objekt') ? cols[colMap.get('objekt')!] || null : null,
      policenummer: colMap.has('policenummer') ? cols[colMap.get('policenummer')!] || null : null,
      udloebsdato: colMap.has('udloebsdato') ? cols[colMap.get('udloebsdato')!] || null : null,
      linje: i + 1,
    });
  }

  return { policer, fejl, kolonner: headers };
}
