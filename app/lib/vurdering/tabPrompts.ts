/**
 * BIZZ-1738: Per-tab prompt templates + Zod output schemas for vurderingsrapport.
 *
 * Each tab has a dedicated system prompt that instructs Claude to produce
 * structured Danish prose following the DLR (Dansk Landbrugs Realkreditfond)
 * vurderingsrapport format. Output is validated via Zod schemas.
 *
 * @module app/lib/vurdering/tabPrompts
 */

import { z } from 'zod';

// ─── Shared formatting ────────────────────────────────────────────────────

const RAPPORT_STIL = `STIL:
- Skriv professionelt dansk — realkredit-tone, ikke uformelt
- Brug konkrete tal med enhed (m², DKK, %)
- Skriv "ikke oplyst" hvis data mangler — gæt ALDRIG
- Returner ALTID valid JSON der matcher det angivne schema
- Ingen markdown, emojis eller formatteringskoder i tekst-felter`;

// ─── 1. Identifikation ───────────────────────────────────────────────────

export const identifikationSchema = z.object({
  sagsoplysninger: z.string().describe('Sagsnr, kunde, besigtigelsesdato'),
  ejendomsbetegnelse: z.string().describe('Adresse, matrikel, ejerlav, BFE'),
  ejendomskategori: z.string().describe('Benyttelse, juridisk kategori, zone'),
  ejerforhold: z.string().describe('Ejerforholdskode med forklaring'),
});

export type IdentifikationOutput = z.infer<typeof identifikationSchema>;

export function identifikationPrompt(sagNummer: string, rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver identifikationsafsnittet i en ${rapportTone}-rapport.

Skriv 4 korte sektioner baseret på de leverede data:
1. "sagsoplysninger" — sagsnummer, kundenavn/-CVR, dato
2. "ejendomsbetegnelse" — fuld adresse, matrikelnr, ejerlav, BFE-nummer
3. "ejendomskategori" — bygningsanvendelse, juridisk kategori, planzone
4. "ejerforhold" — ejerforholdskode oversat til dansk forklaring

Sagsnummer: ${sagNummer}

${RAPPORT_STIL}

Returner JSON: { "sagsoplysninger": "...", "ejendomsbetegnelse": "...", "ejendomskategori": "...", "ejerforhold": "..." }`;
}

// ─── 2. Bygningsdata ─────────────────────────────────────────────────────

export const bygningsdataSchema = z.object({
  oversigt: z.string().describe('Kort opsummering af bygningen'),
  konstruktion: z.string().describe('Murtype, tagtype, etager, asbest'),
  arealer: z.string().describe('Bebygget, bolig, erhverv, grund, bebyggelsesprocent'),
  tilstand: z.string().describe('Opførelsesår, tilbygning, fredning, bevaringsværdi'),
});

export type BygningsdataOutput = z.infer<typeof bygningsdataSchema>;

export function bygningsdataPrompt(rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver bygningsdataafsnittet i en ${rapportTone}-rapport.

Skriv 4 sektioner:
1. "oversigt" — 1-2 sætninger der opsummerer bygningen (type, størrelse, alder)
2. "konstruktion" — ydervæg, tag, etager, asbest-risiko
3. "arealer" — bebygget areal, bolig, erhverv, grundareal, bebyggelsesprocent
4. "tilstand" — opførelsesår, evt. tilbygning, fredning, bevaringsværdighed

${RAPPORT_STIL}

Returner JSON: { "oversigt": "...", "konstruktion": "...", "arealer": "...", "tilstand": "..." }`;
}

// ─── 3. Energi ───────────────────────────────────────────────────────────

export const energiSchema = z.object({
  energimaerke: z.string().describe('Energimærke med vurdering'),
  opvarmning: z.string().describe('Varmeinstallation, opvarmningsmiddel, supplerende'),
  forsyning: z.string().describe('Vandforsyning, afløb'),
  miljoevurdering: z.string().describe('Samlet miljø/energivurdering'),
});

export type EnergiOutput = z.infer<typeof energiSchema>;

export function energiPrompt(rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver energiafsnittet i en ${rapportTone}-rapport.

Skriv 4 sektioner:
1. "energimaerke" — energimærke-klasse + dato + hvad det betyder (A=meget god, G=dårlig)
2. "opvarmning" — varmeinstallation, opvarmningsmiddel, evt. supplerende varme
3. "forsyning" — vandforsyning og afløbsforhold
4. "miljoevurdering" — samlet vurdering af energi/miljø — er ejendommen grøn?

${RAPPORT_STIL}

Returner JSON: { "energimaerke": "...", "opvarmning": "...", "forsyning": "...", "miljoevurdering": "..." }`;
}

// ─── 4. Vurdering & Skat ─────────────────────────────────────────────────

export const vurderingSkatSchema = z.object({
  ejendomsvaerdi: z.string().describe('Ejendomsværdi med kontekst'),
  grundvaerdi: z.string().describe('Grundværdi + afgiftspligtig'),
  skatteberegning: z.string().describe('Grundskyld, promille, estimat'),
  sammenfatning: z.string().describe('Samlet skattemæssig vurdering'),
});

export type VurderingSkatOutput = z.infer<typeof vurderingSkatSchema>;

export function vurderingSkatPrompt(rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver vurderings- og skatteafsnittet i en ${rapportTone}-rapport.

Skriv 4 sektioner med DLR-format (lejeværdi → driftsudgifter → netto → forrentning → vurdering):
1. "ejendomsvaerdi" — offentlig ejendomsværdi med årstal og kontekst
2. "grundvaerdi" — grundværdi, afgiftspligtig grundværdi, bebyggelsesprocent
3. "skatteberegning" — grundskyldspromille × afgiftspligtig grundværdi = estimeret grundskyld
4. "sammenfatning" — samlet vurdering — hvad betyder tallene for ejeren?

${RAPPORT_STIL}

Returner JSON: { "ejendomsvaerdi": "...", "grundvaerdi": "...", "skatteberegning": "...", "sammenfatning": "..." }`;
}

// ─── 5. Tinglysning ─────────────────────────────────────────────────────

export const tinglysningSchema = z.object({
  adkomst: z.string().describe('Aktuelle ejere med andele og overtagelse'),
  handelshistorik: z.string().describe('Salgshistorik med priser og typer'),
  haeftelser: z.string().describe('Pantebreve, realkreditlån, restgæld'),
});

export type TinglysningOutput = z.infer<typeof tinglysningSchema>;

export function tinglysningPrompt(rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver tinglysningsafsnittet i en ${rapportTone}-rapport.

Skriv 3 sektioner:
1. "adkomst" — hvem ejer ejendommen, ejerandele, overtagelsestidspunkt
2. "handelshistorik" — kronologisk salgshistorik med priser og overdragelsestype (fri handel, arv, gave, tvangsauktion). Beregn prisudvikling hvis data tillader det.
3. "haeftelser" — tinglyst gæld: type, hovedstol, restgæld, kreditor, rente. Beregn samlet gæld.

${RAPPORT_STIL}

Returner JSON: { "adkomst": "...", "handelshistorik": "...", "haeftelser": "..." }`;
}

// ─── 6. Servitutter ─────────────────────────────────────────────────────

export const servitutterSchema = z.object({
  oversigt: z.string().describe('Antal og kategorisering af servitutter'),
  vaesentlige: z.string().describe('Servitutter med væsentlig betydning'),
  vurdering: z.string().describe('Samlet vurdering af servitutbyrde'),
});

export type ServitutterOutput = z.infer<typeof servitutterSchema>;

export function servitutterPrompt(rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver servitutafsnittet i en ${rapportTone}-rapport.

Skriv 3 sektioner:
1. "oversigt" — antal servitutter, kategorisering (adgangsret, byggeline, ledningsret, tilslutningspligt, etc.)
2. "vaesentlige" — servitutter med væsentlig betydning for ejendommens anvendelse eller værdi. Citer aktdato + aktnummer.
3. "vurdering" — samlet vurdering: udgør servitutterne en væsentlig byrde for ejendommen? Påvirker de markedsværdien?

Hvis ingen servitutter: skriv "Der er ikke tinglyst servitutter på ejendommen."

${RAPPORT_STIL}

Returner JSON: { "oversigt": "...", "vaesentlige": "...", "vurdering": "..." }`;
}

// ─── 7. Beliggenhed ─────────────────────────────────────────────────────

export const beliggenhedSchema = z.object({
  beliggenhed: z.string().describe('Beliggenhedsbeskrivelse — kvarter, infrastruktur'),
  planforhold: z.string().describe('Planzone, kommune, region'),
  omsaettelighed: z.string().describe('Vurdering af ejendommens omsættelighed'),
});

export type BeliggenhedOutput = z.infer<typeof beliggenhedSchema>;

export function beliggenhedPrompt(rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver beliggenhedsafsnittet i en ${rapportTone}-rapport.

Skriv 3 sektioner:
1. "beliggenhed" — beskriv beliggenhed baseret på adresse, postnr, kommune, region. Nævn nærhed til transport, indkøb, skoler hvis relevant for området.
2. "planforhold" — planzone (byzone/landzone/sommerhuszone), kommune, region. Hvad betyder zonen for anvendelsesmulighederne?
3. "omsaettelighed" — vurder ejendommens omsættelighed: er det et attraktivt område? Stor/lille efterspørgsel?

Besigtigelsesnoter fra vurderingsmanden inkluderes hvis tilgængelige.

${RAPPORT_STIL}

Returner JSON: { "beliggenhed": "...", "planforhold": "...", "omsaettelighed": "..." }`;
}

// ─── 8. Risiko ───────────────────────────────────────────────────────────

export const risikoSchema = z.object({
  miljoe: z.string().describe('Miljørisici — jordforurening, støj, lugt'),
  klima: z.string().describe('Klimarisici — oversvømmelse, stormflod, erosion'),
  byggeteknisk: z.string().describe('Byggetekniske risici — asbest, pcb, skimmel'),
  samletVurdering: z.string().describe('Samlet risikovurdering'),
});

export type RisikoOutput = z.infer<typeof risikoSchema>;

export function risikoPrompt(rapportTone: string): string {
  return `Du er en dansk ejendomsvurderingsmand der skriver risikoafsnittet i en ${rapportTone}-rapport.

Skriv 4 sektioner:
1. "miljoe" — jordforurening, støj, lugt. Basér på zone + beliggenhed (industri vs. boligkvarter)
2. "klima" — oversvømmelsesrisiko, stormflod, erosion. Basér på beliggenhed (kyst/lavtliggende/by)
3. "byggeteknisk" — asbest (baseret på opførelsesår + materiale), PCB, skimmel, radon-risiko
4. "samletVurdering" — samlet risikovurdering: lav/mellem/høj med begrundelse

${RAPPORT_STIL}

Returner JSON: { "miljoe": "...", "klima": "...", "byggeteknisk": "...", "samletVurdering": "..." }`;
}

// ─── Tab registry ───────────────────────────────────────────────────────

/** Map of tab key → Zod schema for output validation. */
export const TAB_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  identifikation: identifikationSchema,
  bygningsdata: bygningsdataSchema,
  energi: energiSchema,
  vurdering_skat: vurderingSkatSchema,
  tinglysning: tinglysningSchema,
  servitutter: servitutterSchema,
  beliggenhed: beliggenhedSchema,
  risiko: risikoSchema,
};

/**
 * Build the system prompt for a given tab.
 *
 * @param tabKey - One of the 8 tab keys
 * @param tone - rapport_tone from sag (realkredit/bankraadgiver/memo)
 * @param sagNummer - Sagsnummer (only used for identifikation tab)
 * @returns System prompt string, or null if tab is unknown
 */
export function buildTabSystemPrompt(
  tabKey: string,
  tone: string,
  sagNummer?: string
): string | null {
  switch (tabKey) {
    case 'identifikation':
      return identifikationPrompt(sagNummer ?? '', tone);
    case 'bygningsdata':
      return bygningsdataPrompt(tone);
    case 'energi':
      return energiPrompt(tone);
    case 'vurdering_skat':
      return vurderingSkatPrompt(tone);
    case 'tinglysning':
      return tinglysningPrompt(tone);
    case 'servitutter':
      return servitutterPrompt(tone);
    case 'beliggenhed':
      return beliggenhedPrompt(tone);
    case 'risiko':
      return risikoPrompt(tone);
    default:
      return null;
  }
}
