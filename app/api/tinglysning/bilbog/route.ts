/**
 * GET /api/tinglysning/bilbog?cvr=12345678
 *
 * Henter bilbogsdata (bilpantebreve, ejerpantebreve, leasingaftaler,
 * ejendomsforbehold for erhvervsbiler) for en virksomhed via
 * Tinglysningsrettens HTTP API.
 *
 * Baggrund (BIZZ-529): Indtil nu har Tinglysning-tab'en på virksomhedsside
 * vist hardcoded "Bilbogen (0)". Denne route tilfører rigtige data fra
 * e-TL's soegbil-endpoint + summariske bil-opslag.
 *
 * Flow:
 *   1. GET /tinglysning/unsecuressl/soegbil?cvr=...  → JSON items[]
 *   2. For hver item.uuid: GET /tinglysning/unsecuressl/bil/uuid/{uuid}
 *      → BilSummariskHentResultat XML → parseBilXml → hæftelser
 *
 * Endpoint-reference: http_api_beskrivelse_v1.12 afsnit 4.2.
 *
 * Retention: Tinglysning-data er offentligt tilgængelig; cache 1 time CDN.
 *
 * @param cvr - CVR-nummer (8 cifre)
 * @returns BilbogData med array af biler og deres hæftelser
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { tlFetch as tlFetchShared } from '@/app/lib/tlFetch';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Enkelt hæftelse på et køretøj — samme elementer som personbogen fordi
 * e-TL bruger fælles Løsøre-XML-skema. Se BilSummariskHentResultat.xsd.
 */
export interface BilHaeftelse {
  /** Hæftelsestype — virksomhedspant, loesoerepant, ejendomsforbehold, ejerpantebrev m.fl. */
  type: string;
  /** Kreditors navn */
  kreditor: string | null;
  /** Kreditors CVR-nummer */
  kreditorCvr: string | null;
  /** Debitornavne (normalt virksomheden selv + evt. medhæftende) */
  debitorer: string[];
  /** Debitor CVR-numre */
  debitorCvr: string[];
  /** Hovedstol i hele kr. */
  hovedstol: number | null;
  /** Valutakode (normalt DKK) */
  valuta: string;
  /** Rentesats i % */
  rente: number | null;
  /** "Fast" eller "Variabel" */
  renteType: string | null;
  /** Tinglysningsdato (ISO) */
  tinglysningsdato: string | null;
  /** Registreringsdato (ISO) */
  registreringsdato: string | null;
  /** Prioritetsnummer */
  prioritet: number | null;
  /** Dokument-UUID til PDF-download via /api/tinglysning/dokument */
  dokumentId: string | null;
  /** Dokumentalias (menneskeligt læsbart dato-løbenummer) */
  dokumentAlias: string | null;
}

/**
 * Ét køretøj med stamdata + tilhørende hæftelser.
 * Returneres som flad række — én per bil knyttet til CVR'et.
 */
export interface BilbogBil {
  /** e-TL UUID til videre opslag */
  uuid: string;
  /** Stelnummer (VIN) */
  stelnummer: string | null;
  /** Registreringsnummer */
  registreringsnummer: string | null;
  /** Fabrikat (fx BMW, Volvo) */
  fabrikat: string | null;
  /** Årgang */
  aargang: string | null;
  /** Alle hæftelser/dokumenter tilknyttet bilen */
  haeftelser: BilHaeftelse[];
}

export interface BilbogData {
  /** Echoed CVR */
  cvr: string;
  /** Alle biler fundet under virksomheden */
  biler: BilbogBil[];
  /** Fejlbesked ved ekstern API-fejl */
  fejl?: string;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Bilbogen bruger /tinglysning/unsecuressl/ prefix — se doc §4.2 */
function tlFetchUnsecure(urlPath: string): Promise<{ status: number; body: string }> {
  return tlFetchShared(urlPath, { apiPath: '/tinglysning/unsecuressl' });
}

/**
 * Normaliserer XML-hæftelsestyper til vores standardtyper.
 * Spejler personbog/route.ts — samme XML-skema deles af bilbog og personbog.
 */
function normalizeType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('virksomhedspant')) return 'virksomhedspant';
  if (lower.includes('ejerpantebrev')) return 'ejerpantebrev';
  if (lower.includes('ejendomsforbehold')) return 'ejendomsforbehold';
  if (lower.includes('leasing')) return 'leasing';
  if (lower.includes('loesoere') || lower.includes('løsøre') || lower.includes('losore'))
    return 'loesoerepant';
  return raw;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

/**
 * Parser BilSummariskHentResultat XML og udtrækker hæftelser.
 *
 * Skema'et spejler LoesoereSummariskHentResultat (brugt til personbogen) —
 * samme navnerum, samme HaeftelseSummarisk-blokke.
 *
 * @param xml - Rå XML-body fra /bil/uuid/{uuid}
 * @returns Array af BilHaeftelse
 * @internal Eksporteret til tests
 */
export function parseBilXml(xml: string): BilHaeftelse[] {
  const haeftelser: BilHaeftelse[] = [];

  const entries = [
    ...xml.matchAll(
      /<(?:ns:)?[Hh]aeftelse(?:Summarisk)?>([\s\S]*?)<\/(?:ns:)?[Hh]aeftelse(?:Summarisk)?>/g
    ),
  ];

  for (const [, entry] of entries) {
    const rawType =
      entry.match(/LoesoereHaeftelseTypeSummariskTekst[^>]*>([^<]+)/)?.[1] ??
      entry.match(/HaeftelsePantebrevFormularLovpligtigKode[^>]*>([^<]+)/)?.[1] ??
      entry.match(/[Hh]aeftelse[Tt]ype[^>]*>([^<]+)/)?.[1] ??
      'ukendt';
    const type = normalizeType(rawType);

    // Kreditor
    const kreditorSamling =
      entry.match(/KreditorInformationSamling>([\s\S]*?)<\/[^>]*KreditorInformationSamling/)?.[1] ??
      '';
    const kreditor =
      kreditorSamling.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
      kreditorSamling.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
      null;
    const kreditorCvr = kreditorSamling.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;

    // Hovedstol + valuta
    const beloebStr = entry.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1];
    const hovedstol = beloebStr ? parseInt(beloebStr, 10) : null;
    const valuta = entry.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';

    // Datoer
    const tinglysningsdato =
      entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? null;
    const registreringsdato =
      entry.match(/RegistreringsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? tinglysningsdato;

    // Prioritet
    const prioritetStr = entry.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
    const prioritet = prioritetStr ? parseInt(prioritetStr, 10) : null;

    // Dokument-ID
    const dokumentId = entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ?? null;
    const dokumentAlias =
      entry.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1] ??
      entry.match(/AktHistoriskIdentifikator[^>]*>([^<]+)/)?.[1] ??
      null;

    // Debitorer
    const debitorSamling =
      entry.match(
        /DebitorInformation(?:Samling)?>([\s\S]*?)<\/[^>]*DebitorInformation(?:Samling)?/
      )?.[1] ?? '';
    const rolleBlocks = [
      ...debitorSamling.matchAll(/RolleInformation>([\s\S]*?)<\/[^>]*RolleInformation/g),
    ];
    const debitorer: string[] = [];
    const debitorCvr: string[] = [];

    if (rolleBlocks.length > 0) {
      for (const [, info] of rolleBlocks) {
        const allNames = [...info.matchAll(/<[^/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
        const name = allNames
          .map((m) => m[1].trim())
          .filter((n) => n.length > 1)
          .join(' ');
        if (name) debitorer.push(name);
        const cvr = info.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1];
        if (cvr) debitorCvr.push(cvr);
      }
    } else {
      const allNames = [...debitorSamling.matchAll(/<[^/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
      for (const m of allNames) {
        if (m[1].trim().length > 1) debitorer.push(m[1].trim());
      }
    }

    // Rente
    const renteStr = entry.match(/(?:Haeftelse)?RentePaalydendeSats[^>]*>([^<]+)/)?.[1];
    const rente = renteStr ? parseFloat(renteStr) : null;
    const renteType =
      entry.match(/(?:Haeftelse)?RenteType(?:Kode)?[^>]*>([^<]+)/)?.[1] ??
      (entry.match(/RenteVariabel/) ? 'Variabel' : entry.match(/RenteFast/) ? 'Fast' : null);

    haeftelser.push({
      type,
      kreditor,
      kreditorCvr,
      debitorer,
      debitorCvr,
      hovedstol,
      valuta,
      rente,
      renteType,
      tinglysningsdato,
      registreringsdato,
      prioritet,
      dokumentId,
      dokumentAlias,
    });
  }

  return haeftelser;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

const querySchema = z.object({
  cvr: z.string().regex(/^\d{8}$/, 'cvr parameter er påkrævet (8 cifre)'),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'cvr parameter er påkrævet (8 cifre)' }, { status: 400 });
  }
  const { cvr } = parsed.data;

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    const empty: BilbogData = { cvr, biler: [], fejl: 'Tinglysning certifikat ikke konfigureret' };
    return NextResponse.json(empty);
  }

  try {
    // Trin 1: Søg i Bilbogen med CVR-nummer
    const searchRes = await tlFetchUnsecure(`/soegbil?cvr=${cvr}`);

    type SearchItem = {
      uuid: string;
      stelnummer?: string | null;
      registreringsnummer?: string | null;
      fabrikat?: string | null;
      aargang?: string | null;
    };

    let items: SearchItem[] = [];
    if (searchRes.status === 200) {
      try {
        const searchData = JSON.parse(searchRes.body) as { items?: SearchItem[] };
        items = searchData?.items ?? [];
      } catch {
        // Ugyldig JSON — log og returner tom liste
        logger.warn('[tinglysning/bilbog] soegbil returned non-JSON body');
      }
    }

    if (items.length === 0) {
      const result: BilbogData = { cvr, biler: [] };
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      });
    }

    // Trin 2: Hent summariske oplysninger for hver bil
    const biler: BilbogBil[] = [];
    for (const item of items) {
      const detailRes = await tlFetchUnsecure(`/bil/uuid/${item.uuid}`);
      const haeftelser = detailRes.status === 200 ? parseBilXml(detailRes.body) : [];

      biler.push({
        uuid: item.uuid,
        stelnummer: item.stelnummer ?? null,
        registreringsnummer: item.registreringsnummer ?? null,
        fabrikat: item.fabrikat ?? null,
        aargang: item.aargang ?? null,
        haeftelser,
      });
    }

    const result: BilbogData = { cvr, biler };
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    logger.error('[tinglysning/bilbog] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
