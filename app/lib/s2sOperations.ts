/**
 * S2S Operations — Tinglysning XML API forespørgsler (BIZZ-1508..1510).
 *
 * Bruger s2sClient.ts til signing+sending. Hver operation:
 *   1. Opslår BFE → Matrikel via REST (kræves af XML API)
 *   2. Bygger unsigned XML request
 *   3. Kalder callS2S() for signing+POST
 *   4. Parser response XML til typed rows
 *
 * Alle operationer returnerer [] ved fejl (graceful degradation).
 * LRU-cached 1 time per BFE.
 *
 * @module app/lib/s2sOperations
 */

import { LruCache } from '@/app/lib/lruCache';
import { logger } from '@/app/lib/logger';
import { tlFetch } from '@/app/lib/tlFetch';
import { callS2S, NS } from '@/app/lib/s2sClient';

// ── Matrikel lookup (shared by all operations) ──

interface MatrikelInfo {
  distName: string;
  distId: string;
  matNr: string;
}

/**
 * REST: BFE → Matrikel info (required by all XML API operations).
 */
async function lookupMatrikel(bfe: number): Promise<MatrikelInfo> {
  const searchRes = await tlFetch(`/ejendom/hovednoteringsnummer?hovednoteringsnummer=${bfe}`, {
    timeout: 15000,
  });
  if (searchRes.status !== 200) throw new Error(`BFE lookup failed: ${searchRes.status}`);
  let uuid: string | null = null;
  try {
    const data = JSON.parse(searchRes.body);
    uuid = data?.items?.[0]?.uuid ?? null;
  } catch {
    /* */
  }
  if (!uuid) throw new Error(`No UUID for BFE ${bfe}`);

  const summRes = await tlFetch(`/ejdsummarisk/${uuid}`, {
    timeout: 15000,
    accept: 'application/xml',
  });
  if (summRes.status !== 200) throw new Error(`Summarisk failed: ${summRes.status}`);
  const xml = summRes.body;
  const distName = xml.match(/CadastralDistrictName[^>]*>([^<]+)/)?.[1];
  const distId = xml.match(/CadastralDistrictIdentifier[^>]*>([^<]+)/)?.[1];
  const matNr = xml.match(/Matrikelnummer[^>]*>([^<]+)/)?.[1];
  if (!distName || !distId || !matNr) throw new Error('Missing Matrikel in summarisk');
  return { distName, distId, matNr };
}

/**
 * Build EjendomIdentifikator XML fragment.
 */
function buildEjendomIdentifikator(bfe: number, mat: MatrikelInfo): string {
  return (
    `<model:EjendomIdentifikator>` +
    `<model:BestemtFastEjendomNummer>${bfe}</model:BestemtFastEjendomNummer>` +
    `<model:Matrikel>` +
    `<kms:CadastralDistrictName>${mat.distName}</kms:CadastralDistrictName>` +
    `<kms:CadastralDistrictIdentifier>${mat.distId}</kms:CadastralDistrictIdentifier>` +
    `<model:Matrikelnummer>${mat.matNr}</model:Matrikelnummer>` +
    `</model:Matrikel>` +
    `</model:EjendomIdentifikator>`
  );
}

/**
 * Build unsigned XML request for an operation.
 */
function buildRequest(operation: string, innerXml: string): string {
  return (
    `<${operation} xmlns="${NS.MSG}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` xsi:schemaLocation="${NS.MSG} ${NS.MSG}${operation}.xsd"` +
    ` xmlns:model="${NS.MODEL}" xmlns:kms="${NS.KMS}">${innerXml}</${operation}>`
  );
}

// ── Adkomster (BIZZ-1508) ──

/** Shape af en aktuel adkomst. */
export interface AdkomstRow {
  dato: string | null;
  dokumentType: string | null;
  koebesumDkk: number | null;
  adkomsthavere: string[];
  rawText: string | null;
}

const adkomstCache = new LruCache<number, AdkomstRow[]>({ maxSize: 150, ttlMs: 3_600_000 });

/**
 * Hent aktuelle adkomster for et BFE via EjendomAdkomsterHent.
 *
 * @param bfe - BFE-nummer
 */
export async function fetchAdkomsterByBfe(bfe: number): Promise<AdkomstRow[]> {
  if (!Number.isFinite(bfe) || bfe <= 0) return [];
  const cached = adkomstCache.get(bfe);
  if (cached) return cached;

  try {
    const mat = await lookupMatrikel(bfe);
    const xml = buildRequest('EjendomAdkomsterHent', buildEjendomIdentifikator(bfe, mat));
    const response = await callS2S('EjendomAdkomsterHent', xml);
    const rows = parseAdkomster(response);
    adkomstCache.set(bfe, rows);
    return rows;
  } catch (err) {
    logger.warn('[s2sOps] adkomster failed BFE', bfe, err instanceof Error ? err.message : err);
    adkomstCache.set(bfe, []);
    return [];
  }
}

/** Parse adkomst entries from XML response. */
function parseAdkomster(xml: string): AdkomstRow[] {
  const entries = [
    ...xml.matchAll(
      /(?:Adkomst|AdkomstSummarisk)>([\s\S]*?)<\/[^:]*:?(?:Adkomst|AdkomstSummarisk)>/g
    ),
  ];
  return entries.map(([, entry]) => {
    const dato =
      entry
        .match(/(?:OvertagelsesDato|SkoedeOvertagelsesDato)[^>]*>([^<]+)/)?.[1]
        ?.split(/[+T]/)[0] ?? null;
    const type = entry.match(/DokumentTypeTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const asciiB64 = entry.match(/AsciiTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const decoded = asciiB64 ? Buffer.from(asciiB64, 'base64').toString('utf-8') : null;
    const koebMatch = decoded?.match(/K[øo]besum:\s*([\d.]+)\s*DKK/i);
    const koebesumDkk = koebMatch ? parseInt(koebMatch[1].replace(/\./g, ''), 10) : null;
    const ahLines = decoded?.split('\n').filter(Boolean).slice(2) ?? [];
    return { dato, dokumentType: type, koebesumDkk, adkomsthavere: ahLines, rawText: decoded };
  });
}

// ── Servitutter (BIZZ-1509) ──

/** Shape af en servitut. */
export interface ServitutRow {
  dato: string | null;
  type: string | null;
  aktNummer: string | null;
  beskrivelse: string | null;
}

const servitutCache = new LruCache<number, ServitutRow[]>({ maxSize: 150, ttlMs: 3_600_000 });

/**
 * Hent servitutter for et BFE via EjendomServitutterHent.
 *
 * @param bfe - BFE-nummer
 */
export async function fetchServitutterByBfe(bfe: number): Promise<ServitutRow[]> {
  if (!Number.isFinite(bfe) || bfe <= 0) return [];
  const cached = servitutCache.get(bfe);
  if (cached) return cached;

  try {
    const mat = await lookupMatrikel(bfe);
    const xml = buildRequest('EjendomServitutterHent', buildEjendomIdentifikator(bfe, mat));
    const response = await callS2S('EjendomServitutterHent', xml);
    const rows = parseServitutter(response);
    servitutCache.set(bfe, rows);
    return rows;
  } catch (err) {
    logger.warn('[s2sOps] servitutter failed BFE', bfe, err instanceof Error ? err.message : err);
    servitutCache.set(bfe, []);
    return [];
  }
}

/** Parse servitut entries from XML response. */
function parseServitutter(xml: string): ServitutRow[] {
  const entries = [...xml.matchAll(/ServitutSummarisk>([\s\S]*?)<\/[^:]*:?ServitutSummarisk>/g)];
  return entries.map(([, entry]) => {
    const dato = entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
    const type = entry.match(/ServitutType[^>]*>([^<]+)/)?.[1] ?? null;
    const aktNr = entry.match(/AktNummer[^>]*>([^<]+)/)?.[1] ?? null;
    const asciiB64 = entry.match(/AsciiTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const beskrivelse = asciiB64 ? Buffer.from(asciiB64, 'base64').toString('utf-8').trim() : null;
    return { dato, type, aktNummer: aktNr, beskrivelse };
  });
}

// ── Hæftelser (BIZZ-1510) ──

/** Shape af en hæftelse. */
export interface HaeftelseRow {
  dato: string | null;
  type: string | null;
  hovedstolDkk: number | null;
  restgaeldDkk: number | null;
  kreditor: string | null;
  aktNummer: string | null;
  rente: number | null;
}

const haeftelseCache = new LruCache<number, HaeftelseRow[]>({ maxSize: 150, ttlMs: 3_600_000 });

/**
 * Hent hæftelser for et BFE via EjendomHaeftelserHent.
 *
 * @param bfe - BFE-nummer
 */
export async function fetchHaeftelserByBfe(bfe: number): Promise<HaeftelseRow[]> {
  if (!Number.isFinite(bfe) || bfe <= 0) return [];
  const cached = haeftelseCache.get(bfe);
  if (cached) return cached;

  try {
    const mat = await lookupMatrikel(bfe);
    const xml = buildRequest('EjendomHaeftelserHent', buildEjendomIdentifikator(bfe, mat));
    const response = await callS2S('EjendomHaeftelserHent', xml);
    const rows = parseHaeftelser(response);
    haeftelseCache.set(bfe, rows);
    return rows;
  } catch (err) {
    logger.warn('[s2sOps] haeftelser failed BFE', bfe, err instanceof Error ? err.message : err);
    haeftelseCache.set(bfe, []);
    return [];
  }
}

/** Parse hæftelse entries from XML response. */
function parseHaeftelser(xml: string): HaeftelseRow[] {
  const entries = [...xml.matchAll(/HaeftelseSummarisk>([\s\S]*?)<\/[^:]*:?HaeftelseSummarisk>/g)];
  return entries.map(([, entry]) => {
    const dato = entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split(/[+T]/)[0] ?? null;
    const type = entry.match(/HaeftelseType[^>]*>([^<]+)/)?.[1] ?? null;
    const aktNr = entry.match(/AktNummer[^>]*>([^<]+)/)?.[1] ?? null;
    const asciiB64 = entry.match(/AsciiTekst[^>]*>([^<]+)/)?.[1] ?? null;
    const decoded = asciiB64 ? Buffer.from(asciiB64, 'base64').toString('utf-8') : null;

    const hovedstolMatch = decoded?.match(/Hovedstol:\s*([\d.]+)\s*DKK/i);
    const restgaeldMatch = decoded?.match(/Restg[æa]ld:\s*([\d.]+)\s*DKK/i);
    const kreditorMatch = decoded?.match(/Kreditor:\s*([^\n]+)/i);
    const renteMatch = decoded?.match(/Rente:\s*([\d,]+)\s*%/i);

    return {
      dato,
      type,
      hovedstolDkk: hovedstolMatch ? parseInt(hovedstolMatch[1].replace(/\./g, ''), 10) : null,
      restgaeldDkk: restgaeldMatch ? parseInt(restgaeldMatch[1].replace(/\./g, ''), 10) : null,
      kreditor: kreditorMatch?.[1]?.trim() ?? null,
      aktNummer: aktNr,
      rente: renteMatch ? parseFloat(renteMatch[1].replace(',', '.')) : null,
    };
  });
}
