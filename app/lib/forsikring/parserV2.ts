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

/**
 * Robust JSON array extraction — finder JSON-array uanset om Claude
 * returnerer forklarende tekst, code blocks, eller ren JSON.
 */
function extractJsonArray(text: string): unknown[] {
  // 1. Prøv ren JSON parse
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  } catch {
    /* not pure JSON */
  }

  // 2. Fjern markdown code blocks og prøv igen
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    if (cleaned.startsWith('[')) return JSON.parse(cleaned);
  } catch {
    /* not in code block */
  }

  // 3. Find første [ ... ] i teksten (håndterer forklarende tekst foran)
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* malformed JSON */
    }
  }

  return [];
}

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

KRITISK — sæt "type" ud fra policens EGEN titel/betegnelse, ikke ud fra branchekode eller bygningens anvendelse (BIZZ-2138):
- "Police - Erhvervsforsikring" / betingelser nr. 2502 / løsøre-dækninger (Brand, Tyveri, Vand for varer/inventar/løsøre), Ran/røveri → "Erhvervsforsikring" (IKKE "Ejendomsforsikring").
- "Police - Bilforsikring" / Kasko / Førerulykke / registreringsnummer → "Bilforsikring".
- "Police - Ejendomsforsikring" / "Bygningsforsikring" / dækning AF selve bygningen (Brand, Storm, Rørskade, Svamp, Insekt på bygningen) → "Ejendomsforsikring".
- Skeln bygningsforsikring (dækker bygningen) fra erhvervsforsikring (dækker løsøre/inventar/varer): en police med løsøre-/inventar-/vare-dækninger er erhverv, ikke ejendom — også selv om der står en adresse.

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
    const result = extractJsonArray(text) as unknown[];
    logger.log(
      `[parserV2] Step 1: ${Array.isArray(result) ? result.length : 0} forsikringstyper identificeret`
    );
    return (Array.isArray(result) ? result : []) as never[];
  } catch {
    logger.error('[parserV2] Step 1 JSON parse fejl:', text.slice(0, 200));
    return [];
  }
}

// ─── Step 2: Enheder per forsikringstype ───────────────────────────

/** Bygningsdata fra police (BIZZ-2145) */
export interface BuildingData {
  navn: string | null;
  anvendelse: string | null;
  bebygget_areal_m2: number | null;
  antal_etager: number | null;
  kaelder: boolean | null;
  opfoert_aar: number | null;
  forsikringsform: string | null;
}

/** Forsikret enhed (ejendom, bil, virksomhed) */
export interface InsuredEntity {
  type: 'ejendom' | 'bil' | 'virksomhed' | 'person' | 'andet';
  label: string;
  adresse: string | null;
  bfe: string | null;
  cvr: string | null;
  registreringsnummer: string | null;
  /** BIZZ-2145: Bygningsdata fra policen */
  bygninger?: BuildingData[];
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

For ejendomme: inkludér bygningsdata hvis nævnt:
- bygninger: array af bygninger med: navn (fx "Bygning 1 - Beboelse"), anvendelse (fx "Restaurant og café"), bebygget_areal_m2, antal_etager, kaelder (true/false), opfoert_aar, forsikringsform (fx "Nyværdi")

Returnér KUN gyldig JSON array:
[{"type": "...", "label": "...", "adresse": "...", "bfe": null, "cvr": null, "registreringsnummer": null, "bygninger": [{"navn": "Bygning 1", "anvendelse": "Beboelse", "bebygget_areal_m2": 249, "antal_etager": 4, "kaelder": true, "opfoert_aar": 1850, "forsikringsform": "Nyværdi"}]}]

OBS: Teksten kan have encoding-issues (ø→», å→}, æ→{) — ignorer det og parse indholdet.

DOKUMENT:
${markdown.slice(0, 30000)}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
  try {
    const result = extractJsonArray(text) as unknown[];
    logger.log(
      `[parserV2] Step 2 (${insurance.type}): ${Array.isArray(result) ? result.length : 0} enheder`
    );
    return (Array.isArray(result) ? result : []) as never[];
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
    const result = extractJsonArray(text) as unknown[];
    logger.log(
      `[parserV2] Step 3 (${entity.label}): ${Array.isArray(result) ? result.length : 0} dækninger`
    );
    return (Array.isArray(result) ? result : []) as never[];
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
    const result = extractJsonArray(text) as unknown[];
    logger.log(
      `[parserV2] Step 4: ${Array.isArray(result) ? result.length : 0} betingelsesreferencer`
    );
    return (Array.isArray(result) ? result : []) as never[];
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
 * BIZZ-2157: Udtræk et dansk registreringsnummer fra police-tekst.
 *
 * Danske nummerplader er 2 bogstaver + 5 cifre (fx "CE 18728" / "CE18728").
 * Kaldes kun når dokumentet allerede er identificeret som en bilforsikring, så
 * et tilfældigt 2+5-mønster i en ejendomspolice ikke fejltolkes som reg.nr.
 *
 * @param tekst - Markdown-tekst fra policen
 * @returns Registreringsnummer uden mellemrum (versaler), eller null
 */
export function extractRegistreringsnummer(tekst: string): string | null {
  const m = tekst.match(/\b([A-ZÆØÅ]{2})\s?(\d{5})\b/);
  return m ? `${m[1]}${m[2]}` : null;
}

/**
 * BIZZ-2157: Deterministisk efter-korrektion af bilforsikringer.
 *
 * LLM'en (Step 1) klassificerer indimellem en bilpolice som "Ejendomsforsikring"
 * — typisk fordi forsikringstageren er et ejendomsselskab — og sætter samtidig
 * et forsikringssted (Step 2), selvom en bilforsikring aldrig har et
 * forsikringssted. Police 172 265 995 (Alm. Brand Bilforsikring, VW Caddy
 * CE18728) er det kanoniske eksempel.
 *
 * Reglerne her er rent deterministiske og kører efter pipelinen:
 *  - En forsikring er en bilforsikring hvis dens type allerede nævner bil/auto,
 *    hvis en af dens enheder har et registreringsnummer, ELLER hvis dokumentet
 *    er en enkelt-police der eksplicit hedder "Bilforsikring"/"Autoforsikring"
 *    og indeholder et registreringsnummer.
 *  - For en bilforsikring tvinges type til "Bilforsikring", og hver enhed får
 *    adresse=null (intet forsikringssted) + type='bil' + reg.nr udfyldt fra
 *    dokumentet hvis det manglede.
 *  - Uafhængigt heraf: enhver enhed der HAR et registreringsnummer får
 *    adresse=null — et køretøj har aldrig et forsikringssted.
 *
 * @param result - Råt v2-parse-resultat
 * @returns Samme resultat med bilforsikringer korrigeret in-place
 */
export function korrigerBilforsikring(result: V2ParseResult): V2ParseResult {
  const markdownBil = /bilforsikring|autoforsikring/i.test(result.markdown);
  const docRegnr = markdownBil ? extractRegistreringsnummer(result.markdown) : null;
  const enkeltPolice = result.insurances.length === 1;

  for (const ins of result.insurances) {
    const typeErBil = /bil|auto|motorkøretøj|motorkoeretoej/i.test(ins.identification.type ?? '');
    const enhedHarRegnr = ins.entities.some((e) => !!e.entity.registreringsnummer);
    const erBil = typeErBil || enhedHarRegnr || (markdownBil && !!docRegnr && enkeltPolice);

    if (erBil) {
      ins.identification.type = 'Bilforsikring';
      for (const e of ins.entities) {
        e.entity.type = 'bil';
        e.entity.adresse = null;
        e.entity.bfe = null;
        e.entity.bygninger = undefined;
        if (!e.entity.registreringsnummer && docRegnr) {
          e.entity.registreringsnummer = docRegnr;
        }
      }
    } else {
      // Køretøjs-enheder i blandede aftaler: et reg.nr betyder intet forsikringssted.
      for (const e of ins.entities) {
        if (e.entity.registreringsnummer) e.entity.adresse = null;
      }
    }
  }

  return result;
}

/**
 * BIZZ-2138: Afgør deterministisk om et dokument er en erhvervsforsikring ud fra
 * præcise signaler i teksten — bruges til at fange policer som LLM'en (Step 1)
 * fejlagtigt klassificerer som "Ejendomsforsikring" fordi forsikringsstedet har
 * en adresse, selvom dækningen er løsøre/inventar/varer (ikke selve bygningen).
 *
 * Signalerne er bevidst snævre for at undgå falske positiver:
 *  - "Police - Erhvervsforsikring"-titel, eller
 *  - reference til Alm. Brands erhvervs-betingelser nr. 2502.
 *
 * @param markdown - Dokumentets råtekst (Step 0-output)
 * @returns true hvis dokumentet entydigt er en erhvervsforsikring
 */
export function erErhvervsforsikringDokument(markdown: string): boolean {
  const policeTitel = /police[\s\-–—]*erhvervsforsikring/i.test(markdown);
  const betingelser2502 = /betingelser?\s*(nr\.?)?\s*2502/i.test(markdown);
  return policeTitel || betingelser2502;
}

/**
 * BIZZ-2138: Deterministisk efter-korrektion af erhvervsforsikringer.
 *
 * Police 60792275 (Alm. Brand Erhvervsforsikring, løsøre: Brand/Tyveri/Vand +
 * Ran/røveri + Retshjælp, betingelser nr. 2502) blev af Step 1 klassificeret
 * som "Ejendomsforsikring" fordi forsikringsstedet har en adresse. En
 * løsøre-/erhvervsforsikring dækker varer/inventar — ikke selve bygningen — og
 * skal klassificeres som erhverv.
 *
 * Reglen er snæver for at beskytte ægte ejendomspolicer: den kører kun på
 * enkelt-police-dokumenter (hvor der ikke er en separat, ægte ejendomsdel) der
 * entydigt er erhvervsforsikringer jf. {@link erErhvervsforsikringDokument},
 * og rører hverken bilforsikringer eller policer der allerede har en ikke-
 * bygnings-type.
 *
 * @param result - v2-parse-resultat (typisk efter {@link korrigerBilforsikring})
 * @returns Samme resultat med fejlklassificerede erhvervspolicer korrigeret
 */
export function korrigerErhvervsforsikring(result: V2ParseResult): V2ParseResult {
  if (result.insurances.length !== 1) return result;
  if (!erErhvervsforsikringDokument(result.markdown)) return result;

  const ins = result.insurances[0];
  const type = ins.identification.type ?? '';
  // Rør ikke biler (håndteres separat) — flip kun en bygnings-/ejendomstype.
  if (/bil|auto/i.test(type)) return result;
  if (/ejendom|bygning/i.test(type)) {
    ins.identification.type = 'Erhvervsforsikring';
  }
  return result;
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

  // BIZZ-2157/2138: Deterministisk korrektion af fejlklassificerede policer —
  // bilforsikringer (type → "Bilforsikring", forsikringssted → null, reg.nr
  // udfyldt) og erhvervsforsikringer (løsøre-policer fejlmærket som ejendom).
  return korrigerErhvervsforsikring(korrigerBilforsikring({ markdown, insurances, conditions }));
}
