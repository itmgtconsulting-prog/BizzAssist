/**
 * BIZZ-716: Entity extraction from domain case documents.
 *
 * Pulls structured identifiers out of case-doc text so the prompt-builder
 * can enrich the generation with BizzAssist's own data (CVR lookup for
 * company name/role, BBR for property metadata, ejerskab for owner chain).
 *
 * Conservative regex design — prefers false negatives over false positives
 * so we don't send the LLM irrelevant data (which would waste tokens AND
 * potentially confuse generation).
 *
 * @module app/lib/domainEntityExtract
 */

export interface ExtractedEntities {
  /** CVR numbers (8 digits, Danish company registry) */
  cvrs: string[];
  /** BFE numbers (5-10 digits, Danish property registry) */
  bfes: string[];
  /** CPR prefixes (6 digits + 4 digits) — surfaced to the caller but the
   *  caller MUST NOT pass these to Claude. Used only for local audit-logging
   *  so case documents containing CPR can be flagged. */
  cprPrefixes: string[];
  /** Det. candidate Danish addresses (Vejnavn Husnr, Postnr By) */
  addresses: string[];
}

// CVR: exactly 8 digits, with word boundaries. Accepts "CVR 12345678",
// "CVR-nr: 12345678", "12345678" in a CVR-context, etc.
const CVR_RE = /(?<![\dA-Za-z])(\d{8})(?![\dA-Za-z])/g;

// BFE: 5-10 digits, with word boundaries. Accepts "BFE 12345",
// "BFE-nr 12345", "BFE: 12345", "BFEnummer 12345" etc.
const BFE_CONTEXT_RE = /\bBFE[\s\-:.]*(?:nr|nummer|nr\.|no)?[\s\-:.]*(\d{5,10})\b/gi;

// CPR prefix: 6 digits followed by hyphen/space + 4 digits. Matches the
// Danish personal-number format. We only extract to audit-log — never
// forward to the LLM.
const CPR_RE = /(?<![\d])(\d{6})[\s-]?(\d{4})(?![\d])/g;

// Address candidate: Vejnavn (capitalised) + husnr + optional etage/dør
// + postnr (4 digits) + by. Keeps things pragmatic.
const ADDRESS_RE =
  /\b([A-ZÆØÅ][a-zæøåA-ZÆØÅ.\- ]{2,40})\s+(\d{1,4}[A-Z]?)(?:,\s*(\d+)\.?\s*([a-zæøå]{2})?)?,\s*(\d{4})\s+([A-ZÆØÅ][a-zæøåA-ZÆØÅ\- ]{2,30})\b/g;

/**
 * Extract structured entities from document text. Returns unique values.
 * Case-insensitive; trims whitespace.
 */
export function extractEntities(text: string): ExtractedEntities {
  if (!text) return { cvrs: [], bfes: [], cprPrefixes: [], addresses: [] };

  // CVRs must be context-anchored: look for "CVR" within 15 chars before
  // the digit run, OR the digits appear on their own line/field.
  const cvrs = new Set<string>();
  const cvrContext = /CVR[\s\-:.]{0,5}(\d{8})\b/gi;
  cvrContext.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = cvrContext.exec(text)) !== null) {
    cvrs.add(m[1]);
  }
  // Fallback: bare 8-digit tokens that aren't also a CPR prefix or date
  CVR_RE.lastIndex = 0;
  while ((m = CVR_RE.exec(text)) !== null) {
    const s = m[1];
    // Exclude if it looks like a DDMMYYYY date (day 01-31, month 01-12)
    const dd = parseInt(s.slice(0, 2), 10);
    const mm = parseInt(s.slice(2, 4), 10);
    const yyyy = parseInt(s.slice(4, 8), 10);
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yyyy >= 1900 && yyyy <= 2100) {
      continue;
    }
    // Exclude if preceded by CPR-like 4-digit suffix pattern already consumed
    cvrs.add(s);
  }

  const bfes = new Set<string>();
  BFE_CONTEXT_RE.lastIndex = 0;
  while ((m = BFE_CONTEXT_RE.exec(text)) !== null) {
    bfes.add(m[1]);
  }

  const cprPrefixes = new Set<string>();
  CPR_RE.lastIndex = 0;
  while ((m = CPR_RE.exec(text)) !== null) {
    const prefix = m[1];
    // Validate birthday plausibility to avoid matching random digit runs
    const dd = parseInt(prefix.slice(0, 2), 10);
    const mm = parseInt(prefix.slice(2, 4), 10);
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) continue;
    cprPrefixes.add(prefix);
  }

  const addresses = new Set<string>();
  ADDRESS_RE.lastIndex = 0;
  while ((m = ADDRESS_RE.exec(text)) !== null) {
    addresses.add(m[0].replace(/\s+/g, ' ').trim());
  }

  return {
    cvrs: [...cvrs],
    bfes: [...bfes],
    cprPrefixes: [...cprPrefixes],
    addresses: [...addresses],
  };
}
