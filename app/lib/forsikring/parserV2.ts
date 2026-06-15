/**
 * BIZZ-2141: Forsikrings-parser v2 — multi-step extraction.
 *
 * I stedet for én kæmpe prompt der er skræddersyet til ét format,
 * bruger v2 en pipeline af simple, generiske steps:
 *
 *   Step 0: PDF → Markdown (Claude Vision — visuelt korrekt, ingen encoding-issues)
 *   Step 1: Identifikation (forsikringstyper, selskab, forsikringstager)
 *   Step 2: Enheder per forsikringstype (adresser, CVR, biler, personer)
 *   Step 3: Dækninger per enhed (beløb, selvrisiko)
 *   Step 4: Betingelser/vilkårsnumre
 *
 * Hvert step er generisk og virker for alle forsikringstyper.
 *
 * @module app/lib/forsikring/parserV2
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/app/lib/logger';

// ─── Step 0: PDF → Markdown ────────────────────────────────────────

/**
 * Konverterer en PDF-buffer til Markdown via Claude Vision.
 * Sender hver side som billede og beder Claude transskribere indholdet.
 *
 * @param pdfBuffer - PDF-bytes
 * @param apiKey - Anthropic API-key
 * @param maxPages - Maks antal sider at konvertere (default 10)
 * @returns Markdown-tekst af hele dokumentet
 */
export async function pdfToMarkdown(pdfBuffer: Buffer, apiKey: string): Promise<string> {
  const client = new Anthropic({ apiKey, timeout: 180_000 });
  const base64 = pdfBuffer.toString('base64');

  // For store PDF'er (>150KB): brug tekst-extraction direkte (ingen Claude-berigelse
  // — Step 1-4 er robuste nok til at håndtere encoding-issues i rå tekst)
  if (pdfBuffer.length > 150_000) {
    logger.log('[parserV2] Step 0: Stor PDF — bruger direkte tekst-extraction');
    const { extractTextFromBuffer } = await import('@/app/lib/domainTextExtraction');
    const extraction = await extractTextFromBuffer(pdfBuffer, 'pdf');
    if (!('ok' in extraction) || !extraction.ok || !extraction.text) {
      throw new Error('Tekst-extraction fejlede for stor PDF');
    }
    logger.log(`[parserV2] Step 0: Stor PDF → rå tekst (${extraction.text.length} tegn)`);
    return extraction.text;
  }

  // Normale PDF'er: send direkte til Claude
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          },
          {
            type: 'text',
            text: `Transskriber HELE dette forsikringsdokument til Markdown. Bevar:
- Alle overskrifter (# ## ###)
- Alle tabeller (| kolonne1 | kolonne2 |)
- Alle beløb, datoer, adresser, CVR-numre, policenumre
- Alle dækninger, selvrisiko, betingelsesreferencer
- Alle forsikringstyper der nævnes
- Alle medforsikrede virksomheder

Returnér KUN Markdown — ingen forklaring eller kommentarer.`,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returnerede intet output for PDF');
  }

  logger.log(`[parserV2] Step 0: PDF → Markdown (${textBlock.text.length} tegn)`);
  return textBlock.text;
}

// ─── Step 1: Identifikation ────────────────────────────────────────

/** Identificeret forsikringstype i dokumentet */
export interface IdentifiedInsurance {
  type: string;
  selskab: string | null;
  policenummer: string | null;
  forsikringstager: string | null;
  forsikringstager_cvr: string | null;
}

/**
 * Step 1: Identificér ALLE forsikringstyper i dokumentet.
 *
 * @param markdown - Markdown-tekst fra Step 0
 * @param apiKey - Anthropic API-key
 * @returns Liste af identificerede forsikringstyper
 */
export async function step1Identify(
  markdown: string,
  apiKey: string
): Promise<IdentifiedInsurance[]> {
  const client = new Anthropic({ apiKey, timeout: 60_000 });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: `Analysér dette forsikringsdokument og identificér ALLE forsikringstyper det indeholder.

For HVER forsikringstype, angiv:
- type: Forsikringstypen (fx "Ejendomsforsikring", "Erhvervsforsikring", "Ansvarsforsikring", "Bilforsikring", "Bygningsforsikring", "Løsøreforsikring")
- selskab: Forsikringsselskab (fx "Alm. Brand Forsikring A/S", "Topdanmark")
- policenummer: Policenummer/aftalenummer
- forsikringstager: Navn på forsikringstager
- forsikringstager_cvr: CVR-nummer (8 cifre) hvis nævnt

Returnér KUN gyldig JSON — et array af objekter:
[{"type": "...", "selskab": "...", "policenummer": "...", "forsikringstager": "...", "forsikringstager_cvr": "..."}]

Et dokument kan indeholde flere forsikringstyper under samme policenummer — opret én entry per type.

OBS: Teksten kan have encoding-issues (ø→», å→}, æ→{) — ignorer det og parse indholdet.

DOKUMENT:
${markdown.slice(0, 30000)}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const result = JSON.parse(cleaned);
    logger.log(
      `[parserV2] Step 1: ${Array.isArray(result) ? result.length : 0} forsikringstyper identificeret`
    );
    return Array.isArray(result) ? result : [];
  } catch {
    logger.error('[parserV2] Step 1 JSON parse fejl:', text.slice(0, 200));
    return [];
  }
}

// ─── Step 2: Enheder per forsikringstype ───────────────────────────

/** Forsikret enhed (ejendom, bil, virksomhed) */
export interface InsuredEntity {
  type: 'ejendom' | 'bil' | 'virksomhed' | 'person' | 'andet';
  label: string;
  adresse: string | null;
  bfe: string | null;
  cvr: string | null;
  registreringsnummer: string | null;
}

/**
 * Step 2: Find alle forsikrede enheder for en given forsikringstype.
 *
 * @param markdown - Markdown-tekst fra Step 0
 * @param insurance - Identificeret forsikring fra Step 1
 * @param apiKey - Anthropic API-key
 * @returns Liste af forsikrede enheder
 */
export async function step2Entities(
  markdown: string,
  insurance: IdentifiedInsurance,
  apiKey: string
): Promise<InsuredEntity[]> {
  const client = new Anthropic({ apiKey, timeout: 60_000 });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: `I dette forsikringsdokument er der en ${insurance.type} (police ${insurance.policenummer ?? 'ukendt'}).

Hvilke enheder/risici er forsikret under denne ${insurance.type}?

For HVER enhed, angiv:
- type: "ejendom" (bygning/grund), "bil" (køretøj), "virksomhed" (erhvervsaktivitet), "person", eller "andet"
- label: Kort beskrivelse (fx "Torvegade 5, 3000 Helsingør" eller "VW Caddy CE18728")
- adresse: Forsikringsstedet/adresse (null for biler/virksomheder uden specifik adresse)
- bfe: BFE-nummer hvis nævnt (null ellers)
- cvr: CVR-nummer hvis relevant (null ellers)
- registreringsnummer: Bilens regnr hvis relevant (null ellers)

Returnér KUN gyldig JSON array:
[{"type": "...", "label": "...", "adresse": "...", "bfe": null, "cvr": null, "registreringsnummer": null}]

OBS: Teksten kan have encoding-issues (ø→», å→}, æ→{) — ignorer det og parse indholdet.

DOKUMENT:
${markdown.slice(0, 30000)}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const result = JSON.parse(cleaned);
    logger.log(
      `[parserV2] Step 2 (${insurance.type}): ${Array.isArray(result) ? result.length : 0} enheder`
    );
    return Array.isArray(result) ? result : [];
  } catch {
    logger.error('[parserV2] Step 2 JSON parse fejl:', text.slice(0, 200));
    return [];
  }
}

// ─── Step 3: Dækninger per enhed ───────────────────────────────────

/** En dækning med beløb */
export interface Coverage {
  navn: string;
  er_daekket: boolean;
  sum_dkk: number | null;
  selvrisiko_dkk: number | null;
  betingelsesref: string | null;
  noter: string | null;
}

/**
 * Step 3: Uddrag dækninger for en specifik enhed under en forsikringstype.
 *
 * @param markdown - Markdown-tekst fra Step 0
 * @param insurance - Forsikringstype fra Step 1
 * @param entity - Enhed fra Step 2
 * @param apiKey - Anthropic API-key
 * @returns Liste af dækninger med beløb
 */
export async function step3Coverages(
  markdown: string,
  insurance: IdentifiedInsurance,
  entity: InsuredEntity,
  apiKey: string
): Promise<Coverage[]> {
  const client = new Anthropic({ apiKey, timeout: 60_000 });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: `I dette forsikringsdokument er der en ${insurance.type} der dækker "${entity.label}".

Hvilke dækninger gælder for denne enhed? List ALLE — både aktive og eksplicit fravalgte.

For HVER dækning, angiv:
- navn: Dækningens navn (fx "Brand", "Erhvervsansvar", "Kasko", "Storm og nedbør")
- er_daekket: true hvis aktiv, false hvis eksplicit fravalgt/ekskluderet
- sum_dkk: Forsikringssum/højeste erstatning i hele DKK (null hvis ikke angivet)
- selvrisiko_dkk: Selvrisiko i hele DKK (null hvis ikke angivet)
- betingelsesref: Betingelsesafsnit/vilkårsnummer (fx "afsnit 100", "DF20904-2") — null hvis ikke nævnt
- noter: Særlige bemærkninger (null hvis ingen)

Returnér KUN gyldig JSON array:
[{"navn": "...", "er_daekket": true, "sum_dkk": null, "selvrisiko_dkk": null, "betingelsesref": null, "noter": null}]

Scan HELE dokumentet — dækninger kan stå i tabeller, lister, eller prosa. Se efter "Forsikringen dækker", "Sådan er bygningen dækket", "Dækningsoversigt", "Dækning / Forsikringssum / Selvrisiko" etc.

OBS: Teksten kan have encoding-issues (ø→», å→}, æ→{) — ignorer det og parse indholdet.

DOKUMENT:
${markdown.slice(0, 30000)}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const result = JSON.parse(cleaned);
    logger.log(
      `[parserV2] Step 3 (${entity.label}): ${Array.isArray(result) ? result.length : 0} dækninger`
    );
    return Array.isArray(result) ? result : [];
  } catch {
    logger.error('[parserV2] Step 3 JSON parse fejl:', text.slice(0, 200));
    return [];
  }
}

// ─── Step 4: Betingelser/vilkår ────────────────────────────────────

/** Refereret betingelse/vilkårsnummer */
export interface ConditionReference {
  ref: string;
  beskrivelse: string | null;
  selskab: string | null;
}

/**
 * Step 4: Find alle refererede standardbetingelser/vilkårsnumre.
 *
 * @param markdown - Markdown-tekst fra Step 0
 * @param apiKey - Anthropic API-key
 * @returns Liste af betingelsesreferencer
 */
export async function step4Conditions(
  markdown: string,
  apiKey: string
): Promise<ConditionReference[]> {
  const client = new Anthropic({ apiKey, timeout: 60_000 });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: `Find ALLE standardbetingelser, vilkårsnumre og forsikringsbetingelsesreferencer i dette dokument.

Typiske formater:
- "Forsikringsbetingelser nr. 2502 Erhvervsforsikring"
- "Vilkårsnr. DF20900-2, DF20904-2"
- "Se betingelsesafsnit 100"
- "Betingelse 100.03, 230.02, 470.02"
- "Alm. Brands forsikringsbetingelser nr. AU 1901"

For HVER reference, angiv:
- ref: Nummeret/koden (fx "2502", "DF20900-2", "100.03", "AU 1901")
- beskrivelse: Hvad det dækker hvis nævnt (fx "Erhvervsforsikring", "Brand") — null ellers
- selskab: Hvilket selskab (fx "Alm. Brand", "Topdanmark") — null ellers

Returnér KUN gyldig JSON array:
[{"ref": "...", "beskrivelse": "...", "selskab": "..."}]

OBS: Teksten kan have encoding-issues (ø→», å→}, æ→{) — ignorer det og parse indholdet.

DOKUMENT:
${markdown.slice(0, 30000)}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const result = JSON.parse(cleaned);
    logger.log(
      `[parserV2] Step 4: ${Array.isArray(result) ? result.length : 0} betingelsesreferencer`
    );
    return Array.isArray(result) ? result : [];
  } catch {
    logger.error('[parserV2] Step 4 JSON parse fejl:', text.slice(0, 200));
    return [];
  }
}

// ─── Full pipeline ─────────────────────────────────────────────────

/** Komplet resultat fra v2-pipeline */
export interface V2ParseResult {
  markdown: string;
  insurances: Array<{
    identification: IdentifiedInsurance;
    entities: Array<{
      entity: InsuredEntity;
      coverages: Coverage[];
    }>;
  }>;
  conditions: ConditionReference[];
}

/**
 * Kør hele v2-pipeline: Step 0 → 1 → 2 → 3 → 4.
 *
 * @param pdfBuffer - PDF-bytes
 * @param apiKey - Anthropic API-key
 * @returns Komplet parse-resultat
 */
export async function parseV2(pdfBuffer: Buffer, apiKey: string): Promise<V2ParseResult> {
  // Step 0: PDF → Markdown
  logger.log('[parserV2] Step 0: Konverterer PDF til Markdown...');
  const markdown = await pdfToMarkdown(pdfBuffer, apiKey);

  // Step 1: Identificér forsikringstyper
  logger.log('[parserV2] Step 1: Identificerer forsikringstyper...');
  const identifications = await step1Identify(markdown, apiKey);

  // Step 2+3: For hver forsikringstype → enheder → dækninger
  const insurances: V2ParseResult['insurances'] = [];
  for (const id of identifications) {
    logger.log(`[parserV2] Step 2: Finder enheder for ${id.type}...`);
    const entities = await step2Entities(markdown, id, apiKey);

    const entitiesWithCoverages: V2ParseResult['insurances'][0]['entities'] = [];
    for (const entity of entities) {
      logger.log(`[parserV2] Step 3: Finder dækninger for ${entity.label}...`);
      const coverages = await step3Coverages(markdown, id, entity, apiKey);
      entitiesWithCoverages.push({ entity, coverages });
    }

    insurances.push({ identification: id, entities: entitiesWithCoverages });
  }

  // Step 4: Betingelser
  logger.log('[parserV2] Step 4: Finder betingelsesreferencer...');
  const conditions = await step4Conditions(markdown, apiKey);

  logger.log(
    `[parserV2] Pipeline komplet: ${identifications.length} typer, ` +
      `${insurances.reduce((sum, i) => sum + i.entities.length, 0)} enheder, ` +
      `${insurances.reduce((sum, i) => sum + i.entities.reduce((s, e) => s + e.coverages.length, 0), 0)} dækninger, ` +
      `${conditions.length} betingelser`
  );

  return { markdown, insurances, conditions };
}
