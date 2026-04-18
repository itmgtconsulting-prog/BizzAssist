/**
 * GET /api/tinglysning/andelsbog?cvr=12345678
 *
 * Henter andelsbogsdata (adkomst til andele + hæftelser på andele) for en
 * virksomhed via Tinglysningsrettens HTTP API.
 *
 * Baggrund (BIZZ-530): Andelsbogen vises i dag som hardcoded "Andelsbogen (0)"
 * placeholder. Denne route leverer rigtige data fra e-TL's andelsbolig-
 * søgeendpoint + summariske andelsbolig-opslag.
 *
 * Flow:
 *   1. GET /tinglysning/ssl/andelsbolig/virksomhed/{cvr} → JSON items[]
 *   2. For hver uuid: GET /tinglysning/ssl/andelsbolig/andelsbolig/{uuid}
 *      → AndelSummariskHentResultat XML → parseAndelXml
 *
 * Endpoint-reference: http_api_beskrivelse_v1.12 afsnit 4.3.
 *
 * Retention: Tinglysning-data er offentligt tilgængelig; CDN-cache 1 time.
 *
 * @param cvr - CVR-nummer (8 cifre)
 * @returns AndelsbogData med array af andelsboliger og deres hæftelser
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
 * Enkelt hæftelse på en andelsbolig — samme Løsøre-skema som personbog/bilbog.
 * e-TL genbruger HaeftelseSummarisk-blokken på tværs af bog-typer.
 */
export interface AndelHaeftelse {
  /** Hæftelsestype — andelspantebrev, ejendomsforbehold m.fl. */
  type: string;
  /** Kreditors navn */
  kreditor: string | null;
  /** Kreditors CVR */
  kreditorCvr: string | null;
  /** Debitornavne */
  debitorer: string[];
  /** Debitor CVR-numre */
  debitorCvr: string[];
  /** Hovedstol i hele kr. */
  hovedstol: number | null;
  /** Valuta (normalt DKK) */
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
  /** Dokument-UUID (PDF via /api/tinglysning/dokument) */
  dokumentId: string | null;
  /** Dokumentalias (menneskeligt dato-løbenummer) */
  dokumentAlias: string | null;
}

/**
 * Én andelsbolig med adresse + adkomst + hæftelser.
 * e-TL returnerer én row pr. andel knyttet til CVR.
 */
export interface AndelsbogBolig {
  /** e-TL UUID for andelsboligen */
  uuid: string;
  /** Sammensat adresse (vejnavn + husnr, evt. etage/side) */
  adresse: string | null;
  /** Postnummer */
  postnr: string | null;
  /** By / postdistrikt */
  by: string | null;
  /** Kommune-navn */
  kommune: string | null;
  /** Etage (fx "st", "1", "2") */
  etage: string | null;
  /** Side/dør (fx "TV", "MF") */
  side: string | null;
  /** Hæftelser registreret på andelen */
  haeftelser: AndelHaeftelse[];
}

export interface AndelsbogData {
  /** Echoed CVR */
  cvr: string;
  /** Andelsboliger fundet under virksomheden */
  andele: AndelsbogBolig[];
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

/** Andelsbogen bruger /tinglysning/ssl/ prefix for S2S adgang */
function tlFetchSsl(urlPath: string): Promise<{ status: number; body: string }> {
  return tlFetchShared(urlPath, { apiPath: '/tinglysning/ssl' });
}

function normalizeType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('andelspantebrev')) return 'andelspantebrev';
  if (lower.includes('ejendomsforbehold')) return 'ejendomsforbehold';
  if (lower.includes('pantebrev')) return 'pantebrev';
  return raw;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

/**
 * Parser AndelSummariskHentResultat XML og udtrækker hæftelser.
 * Genbruger HaeftelseSummarisk-blokken fra personbog/bilbog — e-TL
 * deler samme Løsøre-XML-skema på tværs af bog-typer.
 *
 * Udtrækker også andelsadresse-felter hvis de findes i svaret så én
 * andelsbolig kan rendes uden ekstra DAWA-opslag.
 *
 * @internal Eksporteret til tests
 */
export function parseAndelXml(xml: string): {
  adresse: {
    vejnavn: string | null;
    husnr: string | null;
    etage: string | null;
    side: string | null;
    postnr: string | null;
    by: string | null;
    kommune: string | null;
  };
  haeftelser: AndelHaeftelse[];
} {
  // ── Adressefelter — ligger på andelsbolig-niveau i XML ──
  const vejnavn = xml.match(/VejAdresseringsNavn[^>]*>([^<]+)/)?.[1] ?? null;
  const husnr = xml.match(/HusNummer(?:Identifikator|Tekst)[^>]*>([^<]+)/)?.[1] ?? null;
  const etage = xml.match(/(?:Etage)[^>]*>([^<]+)/)?.[1] ?? null;
  const side = xml.match(/(?:SideDoer|Sidebetegnelse)[^>]*>([^<]+)/)?.[1] ?? null;
  const postnr = xml.match(/(?:PostCodeIdentifier|Postnummer)[^>]*>([^<]+)/)?.[1] ?? null;
  const by = xml.match(/(?:DistrictName|Postdistrikt)[^>]*>([^<]+)/)?.[1] ?? null;
  const kommune = xml.match(/KommuneName[^>]*>([^<]+)/)?.[1] ?? null;

  // ── Hæftelser — samme blokkestruktur som løsørebogen ──
  const haeftelser: AndelHaeftelse[] = [];
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

    const kreditorSamling =
      entry.match(/KreditorInformationSamling>([\s\S]*?)<\/[^>]*KreditorInformationSamling/)?.[1] ??
      '';
    const kreditor =
      kreditorSamling.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
      kreditorSamling.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
      null;
    const kreditorCvr = kreditorSamling.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;

    const beloebStr = entry.match(/BeloebVaerdi[^>]*>(\d+)/)?.[1];
    const hovedstol = beloebStr ? parseInt(beloebStr, 10) : null;
    const valuta = entry.match(/ValutaKode[^>]*>([^<]+)/)?.[1] ?? 'DKK';

    const tinglysningsdato =
      entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? null;
    const registreringsdato =
      entry.match(/RegistreringsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ?? tinglysningsdato;

    const prioritetStr = entry.match(/PrioritetNummer[^>]*>([^<]+)/)?.[1];
    const prioritet = prioritetStr ? parseInt(prioritetStr, 10) : null;

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
    }

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

  return {
    adresse: { vejnavn, husnr, etage, side, postnr, by, kommune },
    haeftelser,
  };
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
    const empty: AndelsbogData = {
      cvr,
      andele: [],
      fejl: 'Tinglysning certifikat ikke konfigureret',
    };
    return NextResponse.json(empty);
  }

  try {
    // Trin 1: Søg i Andelsbogen på CVR
    const searchRes = await tlFetchSsl(`/andelsbolig/virksomhed/${cvr}`);

    type SearchItem = { uuid: string };
    let items: SearchItem[] = [];

    if (searchRes.status === 200) {
      try {
        const data = JSON.parse(searchRes.body) as { items?: SearchItem[] };
        items = data?.items ?? [];
      } catch {
        logger.warn('[tinglysning/andelsbog] andelsbolig/virksomhed returned non-JSON body');
      }
    } else if (searchRes.status !== 404) {
      // 404 er "ingen andele" — returner tom liste. Andre fejl logges.
      logger.warn(
        `[tinglysning/andelsbog] andelsbolig/virksomhed/${cvr} returned HTTP ${searchRes.status}`
      );
    }

    if (items.length === 0) {
      const result: AndelsbogData = { cvr, andele: [] };
      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      });
    }

    // Trin 2: Hent detail per andelsbolig-uuid
    const andele: AndelsbogBolig[] = [];
    for (const item of items) {
      const detailRes = await tlFetchSsl(`/andelsbolig/andelsbolig/${item.uuid}`);
      if (detailRes.status !== 200) continue;

      const { adresse, haeftelser } = parseAndelXml(detailRes.body);
      const adresseStreng = adresse.vejnavn
        ? `${adresse.vejnavn} ${adresse.husnr ?? ''}`.trim() +
          (adresse.etage ? `, ${adresse.etage}.` : '') +
          (adresse.side ? ` ${adresse.side}` : '')
        : null;

      andele.push({
        uuid: item.uuid,
        adresse: adresseStreng,
        postnr: adresse.postnr,
        by: adresse.by,
        kommune: adresse.kommune,
        etage: adresse.etage,
        side: adresse.side,
        haeftelser,
      });
    }

    const result: AndelsbogData = { cvr, andele };
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    logger.error('[tinglysning/andelsbog] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
