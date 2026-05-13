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
import { ParsedPolicySchema, type ParsedPolicy } from './types';
import { stripMarkdownFences } from './jsonHelpers';

export { stripMarkdownFences };

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
    }
  | {
      ok: false;
      text: string | null;
      error: string;
    };

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
      "coverage_code": "brand_el" | "bygningskasko" | "udvidet_roerskade" | "glas" | "sanitet" | "insekt_svamp" | "restvaerdi" | "stikledning" | "jordskade" | "lovliggoerelse" | "huslejetab" | "haerverk" | "omstilling_laase" | "hus_grundejer_ansvar" | "forurening" | "driftstab" | "erhvervsansvar",
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
5. Dækninger: inkluder BÅDE aktive (is_covered:true) OG eksplicit ekskluderede (is_covered:false fra "Forsikringen dækker ikke"-sektioner).
6. Hvis policen kun viser en dækning som tekst uden detaljer, sæt sum_dkk og deductible_dkk til null.
7. coverage_code skal være ÉN af de 17 kanoniske koder ovenfor — map den danske beskrivelse til den nærmeste kode.
8. Hvis policen er en oversigt/sammenfatning af flere policer, vælg den FØRSTE police og parse den.
9. notes-feltet bruges til "Særlige forhold", besigtigelses-bemærkninger og forudsætninger (fx "Uautoriserede el-installationer", "Fedthåndslukker påkrævet").

Returnér nu JSON for følgende police-tekst:`;

/**
 * Parse en PDF-buffer til en struktureret police via Claude.
 *
 * @param pdfBuffer - Rå PDF-bytes
 * @param apiKey - Anthropic API-key (typisk fra BIZZASSIST_CLAUDE_KEY)
 * @returns ParseResult med tekst + struktureret police, eller fejl
 *
 * @example
 * const buf = await file.arrayBuffer().then(b => Buffer.from(b));
 * const result = await parsePolicyPdf(buf, process.env.BIZZASSIST_CLAUDE_KEY!);
 * if (result.ok) {
 *   await db.insertPolicy(result.policy);
 * }
 */
export async function parsePolicyPdf(pdfBuffer: Buffer, apiKey: string): Promise<ParseResult> {
  // Step 1: Ekstrahér tekst fra PDF
  const extraction = await extractTextFromBuffer(pdfBuffer, 'pdf');
  if (!extraction.ok) {
    return { ok: false, text: null, error: `PDF-ekstraktion fejlede: ${extraction.error}` };
  }
  const text = extraction.text;
  if (text.trim().length === 0) {
    return {
      ok: false,
      text: null,
      error: 'PDF indeholder ingen tekst (muligvis scannet billede uden OCR)',
    };
  }

  // Trim hvis for stor — vi prioriterer de første sider hvor police-data ligger
  const trimmedText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

  // Step 2: Send til Claude
  if (!apiKey) {
    return { ok: false, text, error: 'Anthropic API-key mangler' };
  }
  const client = new Anthropic({ apiKey });

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

  return { ok: true, text, policy: validation.data };
}
