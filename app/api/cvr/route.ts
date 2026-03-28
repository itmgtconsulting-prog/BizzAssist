/**
 * GET /api/cvr?vejnavn=...&husnr=...&postnr=...
 *
 * Server-side proxy til Erhvervsstyrelsens CVR OpenData ElasticSearch.
 * Søger virksomheder registreret på en specifik adresse — inkl. ophørte.
 *
 * Endpoint: https://distribution.virk.dk/cvr-permanent/virksomhed/_search
 * Auth:     HTTP Basic Auth (gratis konto på https://datacvr.virk.dk/data/login)
 * Env:      CVR_ES_USER + CVR_ES_PASS i .env.local
 *
 * @param vejnavn - Vejnavn, f.eks. "Arnold Nielsens Boulevard"
 * @param husnr   - Husnummer, f.eks. "64B"
 * @param postnr  - Postnummer, f.eks. "2650"
 * @returns { virksomheder: CVRVirksomhed[], tokenMangler: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape af GET /api/cvr response */
export interface CVRResponse {
  virksomheder: CVRVirksomhed[];
  tokenMangler: boolean;
}

/** En CVR-virksomhed normaliseret fra ElasticSearch */
export interface CVRVirksomhed {
  cvr: number;
  navn: string;
  adresse: string;
  postnr: string;
  by: string;
  telefon: string | null;
  email: string | null;
  branchekode: number | null;
  branche: string | null;
  type: string | null;
  /** Seneste kvartalsbeskæftigelse — antal ansatte */
  ansatte: number | null;
  /** ISO-dato for hvornår virksomheden er aktiv fra (gyldigFra på aktuel status) */
  aktivFra: string | null;
  aktiv: boolean;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'https://distribution.virk.dk/cvr-permanent/virksomhed/_search';

const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Splitter DAWA-husnummer i talpart og bogstavdel.
 * "64B" → { nr: 64, bogstav: "B" }
 * "64"  → { nr: 64, bogstav: null }
 *
 * @param husnr - Husnummer fra DAWA
 */
export function parseHusnr(husnr: string): { nr: number | null; bogstav: string | null } {
  const m = husnr.trim().match(/^(\d+)\s*([A-Za-zÆØÅæøå]*)$/);
  if (!m) return { nr: null, bogstav: null };
  return {
    nr: parseInt(m[1], 10),
    bogstav: m[2]?.toUpperCase() || null,
  };
}

/**
 * Finder den gældende (åbne) periode i et array af tidsbestemte CVR-objekter.
 * Returnerer det sidst kendte element som fallback.
 *
 * @param arr - Array med tidsbestemte objekter fra CVR ElasticSearch
 */
export function gyldigNu<T extends { periode?: { gyldigTil?: string | null } }>(
  arr: T[]
): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Mapper et råt ElasticSearch-hit til CVRVirksomhed.
 * Returnerer null hvis CVR-nummer mangler.
 *
 * @param hit - Rå ES-hit med _source.Vrvirksomhed
 */
function mapESHit(hit: Record<string, unknown>): CVRVirksomhed | null {
  type Periodic = { periode?: { gyldigTil?: string | null } };

  const src = (hit._source as Record<string, unknown> | undefined)?.Vrvirksomhed as
    | Record<string, unknown>
    | undefined;
  if (!src) return null;

  const cvr = typeof src.cvrNummer === 'number' ? src.cvrNummer : null;
  if (!cvr) return null;

  // ── Navn ──
  const navne = Array.isArray(src.navne) ? (src.navne as (Periodic & { navn?: string })[]) : [];
  const navn = gyldigNu(navne)?.navn ?? '';

  // ── Adresse ──
  const adresser = Array.isArray(src.beliggenhedsadresse)
    ? (src.beliggenhedsadresse as (Periodic & Record<string, unknown>)[])
    : [];
  const adr = gyldigNu(adresser);
  const vejnavn = typeof adr?.vejnavn === 'string' ? adr.vejnavn : '';
  const husnummerFra = typeof adr?.husnummerFra === 'number' ? String(adr.husnummerFra) : '';
  const bogstavFra = typeof adr?.bogstavFra === 'string' ? adr.bogstavFra : '';
  const postnr = typeof adr?.postnummer === 'number' ? String(adr.postnummer) : '';
  const by = typeof adr?.postdistrikt === 'string' ? adr.postdistrikt : '';
  const adresseStreng = `${vejnavn} ${husnummerFra}${bogstavFra}`.trim();

  // ── Telefon ──
  const telefoner = Array.isArray(src.telefonnummer)
    ? (src.telefonnummer as (Periodic & { kontaktoplysning?: string })[])
    : [];
  const telefon = gyldigNu(telefoner)?.kontaktoplysning ?? null;

  // ── Email ──
  const emails = Array.isArray(src.emailadresse)
    ? (src.emailadresse as (Periodic & { kontaktoplysning?: string })[])
    : [];
  const email = gyldigNu(emails)?.kontaktoplysning ?? null;

  // ── Branche ──
  const brancher = Array.isArray(src.hovedbranche)
    ? (src.hovedbranche as (Periodic & {
        branchekode?: string | number;
        branchetekst?: string;
      })[])
    : [];
  const brancheNu = gyldigNu(brancher);
  const branchekode =
    brancheNu?.branchekode != null
      ? typeof brancheNu.branchekode === 'number'
        ? brancheNu.branchekode
        : parseInt(String(brancheNu.branchekode), 10)
      : null;
  const branche = typeof brancheNu?.branchetekst === 'string' ? brancheNu.branchetekst : null;

  // ── Virksomhedsform ──
  const former = Array.isArray(src.virksomhedsform)
    ? (src.virksomhedsform as (Periodic & { kortBeskrivelse?: string })[])
    : [];
  const type = gyldigNu(former)?.kortBeskrivelse ?? null;

  // ── Status ──
  const statusser = Array.isArray(src.virksomhedsstatus)
    ? (src.virksomhedsstatus as (Periodic & { statuskode?: string; gyldigFra?: string })[])
    : [];
  const aktuelStatus = gyldigNu(statusser);
  const aktiv = aktuelStatus?.statuskode === 'AKTIV';
  const aktivFra = typeof aktuelStatus?.gyldigFra === 'string' ? aktuelStatus.gyldigFra : null;

  // ── Ansatte (seneste kvartal) ──
  const kvartal = Array.isArray(src.kvartalsbeskaeftigelse)
    ? (src.kvartalsbeskaeftigelse as (Periodic & { antalAnsatte?: number })[])
    : [];
  const senestKvartal = kvartal.length > 0 ? kvartal[kvartal.length - 1] : null;
  const ansatte = senestKvartal?.antalAnsatte ?? null;

  return {
    cvr,
    navn,
    adresse: adresseStreng,
    postnr,
    by,
    telefon,
    email,
    branchekode,
    branche,
    type,
    ansatte,
    aktivFra,
    aktiv,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const vejnavn = searchParams.get('vejnavn') ?? '';
  const husnr = searchParams.get('husnr') ?? '';
  const postnr = searchParams.get('postnr') ?? '';

  if (!vejnavn) {
    return NextResponse.json({ virksomheder: [], tokenMangler: false }, { status: 200 });
  }

  // Returner tokenMangler-flag hvis credentials ikke er sat
  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ virksomheder: [], tokenMangler: true }, { status: 200 });
  }

  const { nr, bogstav } = parseHusnr(husnr);
  const postnrInt = parseInt(postnr, 10);

  // ── Byg ElasticSearch nested query ──
  const adresseFiltre: unknown[] = [
    { match: { 'Vrvirksomhed.beliggenhedsadresse.vejnavn': vejnavn } },
  ];
  if (nr != null) {
    adresseFiltre.push({
      term: { 'Vrvirksomhed.beliggenhedsadresse.husnummerFra': nr },
    });
  }
  if (bogstav) {
    adresseFiltre.push({
      term: { 'Vrvirksomhed.beliggenhedsadresse.bogstavFra': bogstav },
    });
  }
  if (!isNaN(postnrInt)) {
    adresseFiltre.push({
      term: { 'Vrvirksomhed.beliggenhedsadresse.postnummer': postnrInt },
    });
  }

  const esQuery = {
    _source: [
      'Vrvirksomhed.cvrNummer',
      'Vrvirksomhed.navne',
      'Vrvirksomhed.beliggenhedsadresse',
      'Vrvirksomhed.telefonnummer',
      'Vrvirksomhed.emailadresse',
      'Vrvirksomhed.virksomhedsform',
      'Vrvirksomhed.virksomhedsstatus',
      'Vrvirksomhed.hovedbranche',
      'Vrvirksomhed.kvartalsbeskaeftigelse',
    ],
    query: {
      nested: {
        path: 'Vrvirksomhed.beliggenhedsadresse',
        query: {
          bool: { must: adresseFiltre },
        },
      },
    },
    size: 25,
  };

  try {
    const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

    const res = await fetch(CVR_ES_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 1800 },
    });

    if (!res.ok) {
      return NextResponse.json({ virksomheder: [], tokenMangler: false }, { status: 200 });
    }

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };

    const hits = data.hits?.hits ?? [];
    const virksomheder = hits
      .map(mapESHit)
      .filter((v): v is CVRVirksomhed => v !== null)
      // Aktive virksomheder øverst, dernæst ophørte
      .sort((a, b) => Number(b.aktiv) - Number(a.aktiv));

    return NextResponse.json(
      { virksomheder, tokenMangler: false },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=300',
        },
      }
    );
  } catch {
    return NextResponse.json({ virksomheder: [], tokenMangler: false }, { status: 200 });
  }
}
