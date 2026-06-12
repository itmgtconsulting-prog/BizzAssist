/**
 * Forsikrings-PDF parser — uddrager strukturerede police-felter via Claude.
 *
 * Pipeline:
 *   1. PDF → tekst via extractTextFromBuffer (genbruger eksisterende lib)
 *   2. Tekst → Claude Sonnet med struktureret system-prompt
 *   3. Claude-output → Zod-valideret ParsedPolicy
 *
 * Vi bruger response_format-style prompting (JSON-only output) snarere end
 * tool-use fordi det er enklere og giver bedre token-økonomi for one-shot
 * parsing. Caller dispatcher derefter resultatet til insurance-DB-laget.
 *
 * @module app/lib/forsikring/parser
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/app/lib/logger';
import { extractTextFromBuffer } from '@/app/lib/domainTextExtraction';
import type { NormalizedFileType } from '@/app/lib/domainFileTypes';
import {
  COVERAGE_CODES,
  ParsedPolicySchema,
  ParsedOvesigtSchema,
  type ParsedPolicy,
  type ParsedOversigt,
  type DocumentType,
  type DocumentTypeDetection,
} from './types';
import { stripMarkdownFences, canParseAsText, salvageTruncatedOversigt } from './jsonHelpers';

// Re-export for backwards compatibility — callers kan stadig importere fra parser.ts
export { stripMarkdownFences, canParseAsText };

/**
 * Normalisér policenummer: fjern ledende nuller, mellemrum, bindestreger.
 * "067500725" → "67500725", "9417 319 074" → "9417319074".
 *
 * @param policyNumber - Rå policenummer fra parser
 * @returns Normaliseret policenummer
 */
export function normalizePolicyNumber(policyNumber: string): string {
  return policyNumber.replace(/[\s-]+/g, '').replace(/^0+/, '') || policyNumber;
}

/**
 * BIZZ-2097: Afgør om en oversigts-entry er en duplikat af en eksisterende police.
 *
 * Dedup-nøglen er adresse + forsikringstype (policenummeret er allerede matchet
 * af kalderen). Flere forsikringstyper (fx Cyber, Netbank, Driftstab, Kriminalitet)
 * kan ligge under samme aftalenummer UDEN adresse — de må ikke kollapses til én
 * police, hvilket den gamle adresse-eneste sammenligning gjorde (null === null).
 *
 * @param policy - Eksisterende police (property_address + business_activity)
 * @param entry - Oversigts-entry fra parseren (property_address + insurance_type)
 * @returns true hvis entry'en repræsenterer samme police
 */
export function oversigtEntryMatchesPolicy(
  policy: { property_address: string | null; business_activity: string | null },
  entry: { property_address?: string | null; insurance_type?: string | null }
): boolean {
  // Normalisér til trimmet lowercase så whitespace/case-forskelle ikke
  // skaber dubletter; tom streng behandles som null
  const norm = (s: string | null | undefined): string | null => {
    const t = s?.trim().toLowerCase();
    return t ? t : null;
  };
  return (
    norm(policy.property_address) === norm(entry.property_address) &&
    norm(policy.business_activity) === norm(entry.insurance_type)
  );
}

/** Maks tekst-input til Claude (≈40k tokens for sikkerhed). */
const MAX_TEXT_CHARS = 120_000;

/**
 * Resultat af parsing-pipeline. text er den ekstraherede PDF-tekst
 * (gemmes i forsikring_documents.extracted_text), policy er det
 * Zod-validerede output (eller null ved parse-fejl).
 */
export type ParseResult =
  | {
      ok: true;
      text: string;
      policy: ParsedPolicy;
      /** BIZZ-1392: Detekteret dokumenttype */
      documentType: DocumentType;
    }
  | {
      ok: false;
      text: string | null;
      error: string;
    };

/**
 * BIZZ-1392: Resultat fra oversigt-parsing — returnerer N policer.
 */
export type OversightParseResult =
  | {
      ok: true;
      text: string;
      oversigt: ParsedOversigt;
      documentType: 'oversigt';
    }
  | {
      ok: false;
      text: string | null;
      error: string;
    };

/**
 * BIZZ-1392: Samlet resultat fra 2-trins pipeline.
 * Kan returnere én police (ParseResult) eller N policer (OversightParseResult).
 */
export type MultiParseResult = (ParseResult | OversightParseResult) & {
  /** BIZZ-1404: Samlet token-forbrug fra alle Claude-kald i parse-pipeline */
  tokenUsage?: { input: number; output: number };
};

// ─── BIZZ-1392: Trin 1 — Dokumenttype-detektion ─────────────────

/**
 * System-prompt til dokumenttype-detektion (trin 1 i 2-trins pipeline).
 * Hurtig klassificering — max ~200 tokens output.
 */
const DOC_TYPE_SYSTEM_PROMPT = `Du er en specialist i danske forsikringsdokumenter. Din opgave er at klassificere et dokument som én af disse typer:

- "police": En individuel forsikringspolice for én ejendom/risiko. Indeholder typisk policenummer, dækninger, betingelser, præmie.
- "oversigt": En forsikringsoversigt/sammenfatning der lister FLERE policer. Typisk fra mægler eller selskab. Indeholder en tabel/liste med policenumre, selskaber, adresser, præmier for flere ejendomme.
- "tillaeg": Et tillæg, ændring eller endorsement til en eksisterende police. Refererer til et eksisterende policenummer og ændrer dækninger/betingelser.
- "tilbud": Et fornyelsestilbud, pristilbud eller forsikringstilbud. Endnu ikke accepteret police.
- "praemie": En præmieopkrævning/præmiefaktura for en EKSISTERENDE police. Indeholder policenummer, forsikringstager, produkt/forsikringstype, periode og præmiebeløb — men ingen dækningsdetaljer eller betingelser. Typiske kendetegn: "Præmieopkrævning", "Fakturadetaljer", betalingsoplysninger (IBAN/betalingsreference).
- "korrespondance": Brev, email, følgebrev, kvittering eller administrativ kommunikation. Ingen police-data.
- "ukendt": Kan ikke klassificeres som noget af ovenstående.

Returnér KUN gyldig JSON:
{
  "type": "police" | "oversigt" | "tillaeg" | "tilbud" | "praemie" | "korrespondance" | "ukendt",
  "confidence": 0.0-1.0,
  "reason": "Kort begrundelse (max 100 tegn)",
  "policy_count": number | null
}

policy_count: Antal policer i dokumentet. For "police" = 1. For "oversigt" = antal listede policer. For andre = null.

Vigtige regler:
1. Returnér KUN JSON — ingen markdown, ingen forklaring.
2. Hvis dokumentet indeholder en tabel med flere policenumre og adresser → "oversigt".
3. Hvis dokumentet handler om ÉN specifik police med dækninger/betingelser → "police".
4. Vær konservativ: ved tvivl mellem police og oversigt, check om der er flere policenumre.
5. VIGTIGT: Mange forsikringsdokumenter STARTER med et følgebrev (fx "Kære kunde, her er jeres nye forsikringsaftale...") efterfulgt af den egentlige police. Klassificér ALTID baseret på HELE dokumentet — IKKE kun den første side. Hvis teksten indeholder policenummer, dækninger, præmier, selvrisiko osv. efter et følgebrev → det er en "police", IKKE "korrespondance".
6. Forsikringspakker (følgebrev + police + dækningsoversigt i ét dokument) = "police".
7. BIZZ-2083: En præmieopkrævning med policenummer, forsikringstager og præmiebeløb = "praemie" — IKKE "korrespondance", selvom den ligner en faktura/kvittering.`;

/**
 * BIZZ-1392: Trin 1 — Detektér dokumenttype via Claude.
 *
 * @param text - Ekstraheret tekst fra dokumentet (eller første 2000 tegn)
 * @param apiKey - Anthropic API-key
 * @returns DocumentTypeDetection med type, confidence og reason
 */
export async function detectDocumentType(
  text: string,
  apiKey: string
): Promise<DocumentTypeDetection> {
  const client = new Anthropic({ apiKey, timeout: 100_000 });
  // BIZZ-1398: Øget fra 3000 til 8000 tegn — følgebreve fylder typisk 1-2 sider
  // (~2000 tegn), så 3000 rammer kun følgebrevet og misklassificerer som korrespondance
  const sample = text.length > 8000 ? text.slice(0, 8000) : text;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: DOC_TYPE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: sample }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { type: 'ukendt', confidence: 0, reason: 'Claude returnerede intet output' };
    }

    const cleaned = stripMarkdownFences(textBlock.text.trim());
    const parsed = JSON.parse(cleaned) as {
      type?: string;
      confidence?: number;
      reason?: string;
      policy_count?: number;
    };

    const validTypes = [
      'police',
      'oversigt',
      'tillaeg',
      'tilbud',
      'praemie',
      'korrespondance',
      'ukendt',
    ];
    const docType = validTypes.includes(parsed.type ?? '')
      ? (parsed.type as DocumentType)
      : 'ukendt';

    return {
      type: docType,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
      policy_count: typeof parsed.policy_count === 'number' ? parsed.policy_count : undefined,
      tokenUsage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    };
  } catch (err) {
    logger.warn('[forsikring/parser] Dokumenttype-detektion fejlede:', err);
    return { type: 'ukendt', confidence: 0, reason: 'Detektion fejlede' };
  }
}

// ─── BIZZ-1392: Oversigt-parsing ────────────────────────────────

/**
 * System-prompt til oversigt-parsing. Returnerer array af policer fra
 * en forsikringsoversigt.
 */
/**
 * BIZZ-2098: Union-streng af alle kanoniske dækningskoder til prompterne —
 * afledt af COVERAGE_CODES så prompt og Zod-schema aldrig driver fra hinanden.
 */
const COVERAGE_CODE_UNION = COVERAGE_CODES.map((c) => `"${c}"`).join(' | ');

/**
 * BIZZ-2098: Fælles mapping-vejledning for erhvervsdækninger — bruges i både
 * oversigt- og police-prompten så Claude mapper løsøre/kriminalitet/cyber/
 * transport til de nye kanoniske koder i stedet for at tvinge dem ind i
 * bygningskoder (fx "Indbrudstyveri"→udvidet_vandskade-fejlen).
 */
const ERHVERVS_MAPPING_REGEL =
  'ERHVERVSDÆKNINGER: "Erhvervsløsøre / Løsøre / Inventar / Varer" → loesoere, ' +
  '"Indbrudstyveri / Tyveri" → indbrudstyveri, "Ran og røveri" → ran_roeveri, ' +
  '"Oprydning / Oprydningsomkostninger" → oprydning, "Cyber / Cyberforsikring / Datalæk / Ransomware" → cyber, ' +
  '"Cyberdriftstab / Driftstab efter cyberhændelse" → cyberdriftstab, ' +
  '"Notifikation / Notifikationsomkostninger (databrud)" → notifikation, ' +
  '"Netbank / Netbankforsikring" → netbank, "Kriminalitet / Underslæb / Bedrageri" → kriminalitet, ' +
  '"Transport / Varer under transport / Gods" → transport, ' +
  '"Maskinkasko / IT-udstyr All risks / Maskiner og IT-udstyr" → maskiner_itudstyr, ' +
  '"Meromkostninger IT / IT-meromkostninger" → it_meromkostninger, ' +
  '"Leverandørdriftstab / Aftagerdriftstab" → leverandoer_aftager. ' +
  'Bevar ALTID dækningssum (sum_dkk) og selvrisiko (deductible_dkk) pr. dækning når de fremgår.';

const OVERSIGT_SYSTEM_PROMPT = `Du er en specialist i danske forsikringsoversigter. En forsikringsoversigt er et dokument der opsummerer FLERE forsikringspolicer for en kunde.

Din opgave er at udtrække ALLE policer fra oversigten og returnere dem som JSON:

{
  "policies": [
    {
      "policy_number": string,
      "insurer_name": string,
      "insurer_cvr": string | null,
      "policyholder_name": string,
      "policyholder_cvr": string | null,
      "property_address": string | null,
      "insurance_type": string | null,
      "annual_premium_dkk": number | null,
      "sum_insured_dkk": number | null,
      "effective_from": string | null,
      "effective_to": string | null,
      "general_deductible_dkk": number | null,
      "coverages": [
        {
          "coverage_code": ${COVERAGE_CODE_UNION},
          "coverage_label": string,
          "is_covered": boolean,
          "sum_dkk": number | null,
          "deductible_dkk": number | null
        }
      ],
      "notes": string | null
    }
  ],
  "broker_name": string | null,
  "overview_date": string | null,
  "notes": string | null
}

REGLER:
1. Returnér KUN gyldig JSON — ingen markdown, ingen forklaring.
2. Inkluder ALLE policer listet i oversigten — spring ingen over.
3. Beløb: udregn til hele DKK (fx "33.998 kr" → 33998).
4. Datoer: konverter til YYYY-MM-DD format.
5. Hvis en police har flere adresser, opret én entry per adresse med samme policenummer.
6. insurance_type: fx "Bygningsforsikring", "Erhvervsansvar", "Løsøre", etc.
7. Hvis policyholder er den samme for alle policer, gentag navnet i hver entry.
8. KRITISK — DÆKNINGER: Scan HELE dokumentet for dæknings-sektioner ("Sådan er bygningen dækket", "Dækninger og dækningssummer", "Forsikringsdækninger"). Ekstraher ALLE dækninger som coverages[]. En typisk police har 8-15 dækninger. Mapping: "Brand/Pludselig skade"→brand_el, "Storm/Nedbør"→bygningskasko, "Udstrømning af vand/Rørskade"→udvidet_roerskade, "Glas"→glas, "Sanitet"→sanitet, "Svamp/Insekt"→insekt_svamp, "Restværdi"→restvaerdi, "Stikledning"→stikledning, "Jordskade"→jordskade, "Huslejetab"→huslejetab, "Hærværk"→haerverk, "Omstilling af låse"→omstilling_laase, "Hus-/Grundejeransvar"→hus_grundejer_ansvar, "Udvidet vandskade"→udvidet_vandskade. ${ERHVERVS_MAPPING_REGEL}
9. coverage_code skal matche én af de kanoniske koder ovenfor. Hvis en dækning ikke passer, brug den nærmeste — men tving ALDRIG en erhvervsdækning (løsøre, tyveri, cyber, transport, kriminalitet) ind i en bygningskode. Finder du færre end 5, gennemlæs dokumentet igen.
10. ADRESSE-KONTEKST (KRITISK): property_address er forsikringsSTEDET for den enkelte police — den adresse policens dækning gælder for. Brug ALDRIG kundens generelle virksomheds-, kontakt-, cc- eller adressat-adresse fra oversigtens brevhoved som property_address. Kun adresser der i oversigten eksplicit er knyttet til den enkelte police som forsikringssted må bruges — ellers null. Forsikringstagerens egen adresse hører til i policyholder_address.

Returnér nu JSON for følgende forsikringsoversigt:`;

/**
 * BIZZ-1392: Parse en forsikringsoversigt til N individuelle policer.
 *
 * @param text - Fuld ekstraheret tekst fra oversigts-dokumentet
 * @param apiKey - Anthropic API-key
 * @returns OversightParseResult med array af policer
 */
export async function parseOversigt(text: string, apiKey: string): Promise<OversightParseResult> {
  // BIZZ-2081: Streaming + 16k output-tokens — store oversigter (mange policer
  // med coverages) genererer mere JSON end de tidligere 8k tokens, hvilket
  // afkortede svaret midt i en streng og fik JSON.parse til at fejle.
  const client = new Anthropic({ apiKey, timeout: 240_000 });
  const trimmedText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

  let response: Anthropic.Message;
  try {
    response = await client.messages
      .stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: OVERSIGT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: trimmedText }],
      })
      .finalMessage();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    logger.error('[forsikring/parser] Oversigt-parsing fejlede:', msg);
    return { ok: false, text, error: `Claude-kald fejlede: ${msg}` };
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { ok: false, text, error: 'Claude returnerede intet output for oversigt' };
  }

  const cleaned = stripMarkdownFences(textBlock.text.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // BIZZ-2081: Salvage — hvis svaret blev afkortet ved max_tokens, red de
    // komplette police-objekter i stedet for at fejle hele parsingen.
    const salvaged =
      response.stop_reason === 'max_tokens' ? salvageTruncatedOversigt(cleaned) : null;
    if (salvaged) {
      logger.warn(
        `[forsikring/parser] Oversigt-JSON afkortet ved max_tokens — reddede ${salvaged.policies.length} komplette policer`
      );
      parsed = salvaged;
    } else {
      const msg = err instanceof Error ? err.message : 'unknown';
      return { ok: false, text, error: `Oversigt-output er ikke gyldig JSON: ${msg}` };
    }
  }

  const validation = ParsedOvesigtSchema.safeParse(parsed);
  if (!validation.success) {
    const issueSummary = validation.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, text, error: `Oversigt-schema-validering fejlede: ${issueSummary}` };
  }

  return { ok: true, text, oversigt: validation.data, documentType: 'oversigt' };
}

/**
 * System-prompt til Claude. Beskriver opgaven, forventet schema og
 * regler for hvordan parser skal håndtere uklarheder.
 */
const SYSTEM_PROMPT = `Du er en specialiseret parser af danske bygnings-forsikringspolicer (Alm. Brand, Topdanmark, Tryg, Codan, Gjensidige, If, etc.).

Din opgave er at uddrage strukturerede felter fra rå PDF-tekst og returnere ét gyldigt JSON-objekt der følger dette schema EKSAKT:

{
  "policy_number": string,                    // Policenummer (uden mellemrum)
  "insurer_name": string,                     // Fx "Alm. Brand Forsikring A/S"
  "insurer_cvr": string | null,               // 8 cifre, ingen mellemrum
  "broker_name": string | null,               // Fx "RTM Insurance Brokers A/S"
  "policyholder_name": string,                // Fx "Belvedere Ejendomme A/S"
  "policyholder_cvr": string | null,
  "policyholder_address": string | null,
  "property_address": string | null,          // Forsikringsstedet
  "property_matrikel": string | null,         // Fx "498 A, Helsingør Bygrunde"
  "property_bfe": string | null,              // BFE-nummer hvis nævnt
  "business_activity": string | null,         // Fx "Restaurant og café"
  "building_use": string | null,              // Fx "Hotel" eller "Værksted"
  "building_area_m2": number | null,          // Bebygget areal
  "building_floors": number | null,
  "building_year_built": number | null,
  "building_has_basement": boolean | null,
  "insurance_form": "nyvaerdi" | "sum" | "f_risiko" | "nedrivning" | "uforsikret" | null,
  "sum_insured_dkk": number | null,           // Hvis explicit forsikringssum
  "annual_premium_dkk": number | null,
  "general_deductible_dkk": number | null,
  "effective_from": string | null,            // YYYY-MM-DD
  "effective_to": string | null,              // YYYY-MM-DD (aftale-udløb)
  "main_renewal_date": string | null,         // YYYY-MM-DD (hovedforfald i indeværende år)
  "policy_issued_date": string | null,        // YYYY-MM-DD (police-tegningsdato)
  "coverages": [
    {
      "coverage_code": ${COVERAGE_CODE_UNION},
      "coverage_label": string,               // Original tekst fra policen
      "is_covered": boolean,                  // false hvis explicit ekskluderet
      "sum_dkk": number | null,
      "deductible_dkk": number | null,
      "conditions_ref": string | null,        // Fx "100.03"
      "notes": string | null
    }
  ],
  "notes": string | null                      // Særlige forhold, besigtigelses-bemærkninger, krav (max 5000 tegn)
}

REGLER:
1. Returnér KUN gyldig JSON — ingen markdown, ingen forklaring før/efter.
2. Hvis et felt ikke kan findes i teksten, sæt det til null (ikke "ukendt" eller tom streng).
3. Belob: udregn til hele DKK uden punktum eller komma (fx "33.998 kr" → 33998).
4. Datoer: konverter "8. juli 2022" → "2022-07-08", "1. april" → brug indeværende eller næste år som passende.
5. KRITISK — DÆKNINGER: Du SKAL scanne HELE dokumentet fra start til slut for dækninger. Søg specifikt efter sektioner med overskrifter som "Sådan er bygningen dækket", "Dækninger og dækningssummer", "Forsikringsdækninger", "Dækningsoversigt", "Bygningsforsikring dækker" — disse ligger typisk MIDT eller SIDST i dokumentet (side 4-8), IKKE i starten. Inkludér ALLE fundne dækninger — både aktive (is_covered:true) OG eksplicit ekskluderede (is_covered:false).
6. MAPPING-EKSEMPLER: "Brand inkl. pludselig skade" → brand_el, "Storm og nedbør" → bygningskasko, "Udstrømning af vand / Rørskade" → udvidet_roerskade, "Glas" → glas, "Sanitet" → sanitet, "Svamp / Insekt" → insekt_svamp, "Restværdi" → restvaerdi, "Stikledning" → stikledning, "Jordskade / Grundejerskade" → jordskade, "Lovliggørelse" → lovliggoerelse, "Huslejetab" → huslejetab, "Hærværk" → haerverk, "Omstilling af låse" → omstilling_laase, "Husejer- / Grundejeransvar" → hus_grundejer_ansvar, "Forurening" → forurening, "Driftstab" → driftstab, "Erhvervsansvar" → erhvervsansvar, "Udvidet vandskade / Oversvømmelse" → udvidet_vandskade. ${ERHVERVS_MAPPING_REGEL}
7. Hvis policen kun viser en dækning som tekst uden detaljer, sæt sum_dkk og deductible_dkk til null.
8. coverage_code skal være ÉN af de kanoniske koder ovenfor — map den danske beskrivelse til den nærmeste kode, men tving ALDRIG en erhvervsdækning (løsøre, tyveri, cyber, transport, kriminalitet) ind i en bygningskode.
9. Hvis policen er en oversigt/sammenfatning af flere policer, vælg den FØRSTE police og parse den.
10. notes-feltet bruges til "Særlige forhold", besigtigelses-bemærkninger og forudsætninger (fx "Uautoriserede el-installationer", "Fedthåndslukker påkrævet").
11. En typisk dansk bygningsforsikrings-police har 8-15 dækninger. Hvis du finder færre end 5 coverages, gennemlæs dokumentet IGEN — du har sandsynligvis overset en dæknings-sektion.
12. ADRESSE-KONTEKST (KRITISK): Vurdér i hvilken kontekst hver adresse i dokumentet nævnes. property_address må KUN indeholde forsikringsSTEDET — den adresse en dækning gælder for (typisk markeret "Forsikringssted", "Forsikret ejendom", "Beliggenhed"). Adresser der kun optræder som forsikringstagers virksomhedsadresse, kontaktadresse, cc-/adressat-adresse, mægler-adresse eller i brevhoved/følgebrev må ALDRIG bruges som property_address — forsikringstagerens egen adresse hører til i policyholder_address. Findes intet eksplicit forsikringssted, sæt property_address til null.

Returnér nu JSON for følgende police-tekst:`;

/**
 * Parse en fil-buffer til en struktureret police via Claude.
 *
 * Understøtter PDF, DOCX, XLSX, PPTX, RTF, plain text-familien
 * (txt/md/csv/tsv/json/xml/yaml/log/code), HTML og EML. Billeder
 * (PNG/JPG/GIF/WEBP) håndteres via parsePolicyImage (Claude vision).
 *
 * @param fileBuffer - Rå fil-bytes
 * @param fileType - NormalizedFileType (pdf/docx/xlsx/...)
 * @param apiKey - Anthropic API-key (typisk fra BIZZASSIST_CLAUDE_KEY)
 * @returns ParseResult med tekst + struktureret police, eller fejl
 *
 * @example
 * const buf = await file.arrayBuffer().then(b => Buffer.from(b));
 * const result = await parsePolicyFile(buf, 'pdf', process.env.BIZZASSIST_CLAUDE_KEY!);
 * if (result.ok) {
 *   await db.insertPolicy(result.policy);
 * }
 */
export async function parsePolicyFile(
  fileBuffer: Buffer,
  fileType: NormalizedFileType,
  apiKey: string
): Promise<ParseResult> {
  // Step 0: Validér at filtypen kan parses tekstuelt
  if (!canParseAsText(fileType)) {
    return {
      ok: false,
      text: null,
      error: `Filtype ${fileType} understøttes ikke af tekst-parseren. Billeder skal bruge parsePolicyImage.`,
    };
  }

  // Step 1: Ekstrahér tekst fra fil
  const extraction = await extractTextFromBuffer(fileBuffer, fileType);
  if (!extraction.ok) {
    return {
      ok: false,
      text: null,
      error: `Tekst-ekstraktion fejlede (${fileType}): ${extraction.error}`,
    };
  }
  const text = extraction.text;
  if (text.trim().length === 0) {
    return {
      ok: false,
      text: null,
      error: `${fileType.toUpperCase()} indeholder ingen tekst (muligvis scannet billede uden OCR)`,
    };
  }

  // Trim hvis for stor — vi prioriterer de første sider hvor police-data ligger
  const trimmedText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

  // Step 2: Send til Claude
  if (!apiKey) {
    return { ok: false, text, error: 'Anthropic API-key mangler' };
  }
  const client = new Anthropic({ apiKey, timeout: 100_000 });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: trimmedText,
        },
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    logger.error('[forsikring/parser] Claude-kald fejlede:', msg);
    return { ok: false, text, error: `Claude-kald fejlede: ${msg}` };
  }

  // Step 3: Ekstrahér text-block fra Claude-svar
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { ok: false, text, error: 'Claude returnerede intet tekst-output' };
  }
  const rawJson = textBlock.text.trim();

  // Step 4: Parse JSON (toleré markdown-fences hvis Claude alligevel inkluderer dem)
  const cleaned = stripMarkdownFences(rawJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    logger.warn('[forsikring/parser] JSON-parse fejlede:', msg);
    return { ok: false, text, error: `Claude-output er ikke gyldig JSON: ${msg}` };
  }

  // Step 5: Validér mod Zod-schema
  const validation = ParsedPolicySchema.safeParse(parsed);
  if (!validation.success) {
    const issueSummary = validation.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    logger.warn('[forsikring/parser] Schema-validering fejlede:', issueSummary);
    return {
      ok: false,
      text,
      error: `Claude-output passer ikke til schema: ${issueSummary}`,
    };
  }

  return { ok: true, text, policy: validation.data, documentType: 'police' };
}

/**
 * Bagudkompatibel alias for parsePolicyFile med type='pdf'.
 * Bevares så eksisterende API-routes ikke skal opdateres samtidig.
 *
 * @deprecated Brug parsePolicyFile(buffer, 'pdf', apiKey) direkte
 * @param pdfBuffer - PDF-bytes
 * @param apiKey - Anthropic API-key
 * @returns ParseResult
 */
export async function parsePolicyPdf(pdfBuffer: Buffer, apiKey: string): Promise<ParseResult> {
  return parsePolicyFile(pdfBuffer, 'pdf', apiKey);
}

/**
 * Claude vision MIME-types — match dem bucket-policy tillader.
 */
const VISION_MIME_BY_TYPE: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> =
  {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };

/**
 * Parse et police-billede (scannet PDF som JPG/PNG, foto af police) via
 * Claude vision. Bruger samme system-prompt og output-schema som
 * tekst-parseren, men sender base64-billede i stedet for tekst.
 *
 * @param imageBuffer - Billed-bytes
 * @param mimeSubtype - 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp'
 * @param apiKey - Anthropic API-key
 * @returns ParseResult — text-feltet er Claude's OCR-output (kan bruges senere)
 *
 * @example
 * const result = await parsePolicyImage(buf, 'jpg', apiKey);
 */
export async function parsePolicyImage(
  imageBuffer: Buffer,
  mimeSubtype: string,
  apiKey: string
): Promise<ParseResult> {
  const mediaType = VISION_MIME_BY_TYPE[mimeSubtype.toLowerCase()];
  if (!mediaType) {
    return {
      ok: false,
      text: null,
      error: `Billed-format ${mimeSubtype} understøttes ikke. Brug png/jpg/gif/webp.`,
    };
  }
  if (!apiKey) {
    return { ok: false, text: null, error: 'Anthropic API-key mangler' };
  }

  const base64 = imageBuffer.toString('base64');
  const client = new Anthropic({ apiKey, timeout: 100_000 });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system:
        SYSTEM_PROMPT +
        '\n\nDu vil modtage et billede af en police (scannet PDF eller foto). ' +
        'Læs alle synlige tekstfelter og uddrag dem som angivet i schemaet.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: 'Parse dette billede til struktureret JSON som beskrevet i system-prompten.',
            },
          ],
        },
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    logger.error('[forsikring/parser] Claude vision-kald fejlede:', msg);
    return { ok: false, text: null, error: `Claude vision fejlede: ${msg}` };
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { ok: false, text: null, error: 'Claude returnerede intet output for billede' };
  }
  const rawJson = textBlock.text.trim();
  const cleaned = stripMarkdownFences(rawJson);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return { ok: false, text: rawJson, error: `Vision-output er ikke gyldig JSON: ${msg}` };
  }

  const validation = ParsedPolicySchema.safeParse(parsed);
  if (!validation.success) {
    const issueSummary = validation.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      text: rawJson,
      error: `Vision-output passer ikke til schema: ${issueSummary}`,
    };
  }

  return { ok: true, text: rawJson, policy: validation.data, documentType: 'police' };
}

// ─── BIZZ-1392: 2-trins pipeline ───────────────────────────────

/**
 * BIZZ-1392: Fuld 2-trins parsing-pipeline med dokumenttype-detektion.
 *
 * Trin 1: Detektér dokumenttype (police/oversigt/tillaeg/tilbud/korrespondance/ukendt)
 * Trin 2: Parse baseret på type:
 *   - police → parsePolicyFile (1 dok → 1 police)
 *   - oversigt → parseOversigt (1 dok → N policer)
 *   - andre → returnér fejl med dokumenttype-info
 *
 * @param fileBuffer - Rå fil-bytes
 * @param fileType - NormalizedFileType
 * @param apiKey - Anthropic API-key
 * @returns MultiParseResult — enten én police eller N policer fra oversigt
 */
export async function parseWithTypeDetection(
  fileBuffer: Buffer,
  fileType: NormalizedFileType,
  apiKey: string
): Promise<MultiParseResult> {
  // Step 0: Validér at filtypen kan parses tekstuelt
  if (!canParseAsText(fileType)) {
    return {
      ok: false,
      text: null,
      error: `Filtype ${fileType} understøttes ikke af tekst-parseren. Billeder skal bruge parsePolicyImage.`,
    };
  }

  // Step 1: Ekstrahér tekst
  const extraction = await extractTextFromBuffer(fileBuffer, fileType);
  if (!extraction.ok) {
    return { ok: false, text: null, error: `Tekst-ekstraktion fejlede: ${extraction.error}` };
  }
  const text = extraction.text;
  if (text.trim().length === 0) {
    return { ok: false, text: null, error: 'Dokumentet indeholder ingen tekst' };
  }

  // Step 2: Detektér dokumenttype
  const detection = await detectDocumentType(text, apiKey);
  logger.log(
    `[forsikring/parser] Dokumenttype: ${detection.type} (confidence: ${detection.confidence}, count: ${detection.policy_count ?? '?'})`
  );

  // BIZZ-1404: Accumulate token usage from detection + subsequent parse
  const totalTokens = {
    input: detection.tokenUsage?.input ?? 0,
    output: detection.tokenUsage?.output ?? 0,
  };

  // Step 3: Route baseret på type
  switch (detection.type) {
    case 'oversigt': {
      // Parse som oversigt → N policer
      return parseOversigt(text, apiKey);
    }
    case 'police':
    case 'tillaeg':
    case 'praemie': {
      // Parse som individuel police (tillæg parses som police — caller kan matche).
      // BIZZ-2083: Præmieopkrævninger indeholder policenummer, forsikringstager,
      // produkt, periode og præmie — nok til at policen kan indgå i gap-analysen.
      // Manglende dækningsdetaljer parses som null.
      const trimmedText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
      if (!apiKey) {
        return { ok: false, text, error: 'Anthropic API-key mangler' };
      }
      const client = new Anthropic({ apiKey, timeout: 100_000 });
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: trimmedText }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        return { ok: false, text, error: `Claude-kald fejlede: ${msg}` };
      }
      // BIZZ-1404: Accumulate parse-tokens
      totalTokens.input += response.usage?.input_tokens ?? 0;
      totalTokens.output += response.usage?.output_tokens ?? 0;
      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        return { ok: false, text, error: 'Claude returnerede intet output' };
      }
      const cleaned = stripMarkdownFences(textBlock.text.trim());
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        return { ok: false, text, error: `JSON-parse fejlede: ${msg}` };
      }
      const validation = ParsedPolicySchema.safeParse(parsed);
      if (!validation.success) {
        const issueSummary = validation.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        return { ok: false, text, error: `Schema-validering fejlede: ${issueSummary}` };
      }
      return {
        ok: true,
        text,
        policy: validation.data,
        documentType: detection.type,
        tokenUsage: totalTokens,
      };
    }
    case 'tilbud':
      return {
        ok: false,
        text,
        error: `Dokumentet er et forsikringstilbud — ikke en gyldig police. Upload den endelige police i stedet.`,
      };
    case 'korrespondance': {
      // BIZZ-1398: Samlede police-pakker (følgebrev + police) fejlklassificeres
      // som korrespondance. Check for police-nøgleord i HELE teksten — hvis de
      // findes, er det sandsynligvis en police pakket med et følgebrev.
      // Nøgleord med BEGGE varianter: korrekt dansk (æ/å/ø) OG garbled
      // PDF-encoding ({/}/») som visse PDF-ekstraktorer returnerer.
      const policyKeywords = [
        'forsikringsaftale',
        'dækningsoversigt',
        'd{kningsoversigt',
        'vilkårsnr',
        'vilk}rsnr',
        'selvrisiko',
        'forsikringstype',
        'dækningssum',
        'd{kningssum',
        'forsikringssted',
        'erhvervsansvar',
        'ejendomsforsikring',
        'bygningsforsikring',
        'forsikringen dækker',
        'forsikringen d{kker',
        'forsikringen gælder',
        'forsikringen g{lder',
      ];
      const lowerText = text.toLowerCase();
      // BIZZ-2083: Præmieopkrævninger er korte (ofte <1000 tegn) men indeholder
      // policenummer + forsikringstager + præmie. Fang dem her hvis
      // klassifikationen alligevel valgte korrespondance.
      const erPraemieopkraevning =
        (lowerText.includes('præmieopkrævning') || lowerText.includes('pr{mieopkr{vning')) &&
        (lowerText.includes('policenummer') || lowerText.includes('policenr'));
      if (erPraemieopkraevning) {
        logger.log(
          '[forsikring/parser] Korrespondance ligner præmieopkrævning → fallback til police-parsing'
        );
        return parsePolicyFile(fileBuffer, fileType, apiKey);
      }
      const matchCount = policyKeywords.filter((kw) => lowerText.includes(kw)).length;
      if (matchCount >= 2 && text.length > 3000) {
        logger.log(
          `[forsikring/parser] Korrespondance med ${matchCount} police-nøgleord → fallback til police-parsing`
        );
        return parsePolicyFile(fileBuffer, fileType, apiKey);
      }
      return {
        ok: false,
        text,
        error: `Dokumentet er korrespondance (brev/email) — ikke en forsikringspolice.`,
      };
    }
    case 'ukendt':
    default:
      // Fallback: prøv at parse som police alligevel (backward compat)
      logger.warn('[forsikring/parser] Ukendt dokumenttype — fallback til police-parsing');
      return parsePolicyFile(fileBuffer, fileType, apiKey);
  }
}
