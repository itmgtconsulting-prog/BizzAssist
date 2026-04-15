/**
 * GET /api/cvr/[cvr]
 *
 * Server-side proxy til Erhvervsstyrelsens CVR OpenData ElasticSearch.
 * Henter virksomhedsdata for et enkelt CVR-nummer.
 *
 * Endpoint: https://distribution.virk.dk/cvr-permanent/virksomhed/_search
 * Auth:     HTTP Basic Auth via CVR_ES_USER + CVR_ES_PASS i .env.local
 *
 * @param context.cvr - 8-cifret dansk CVR-nummer
 * @returns CVRSelskab objekt eller { error } ved fejl
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { proxyUrl } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';

/** Zod schema for the [cvr] dynamic param — 8-digit string */
const cvrParamSchema = z.object({ cvr: z.string().regex(/^\d{8}$/, 'CVR skal være 8 cifre') });

// ─── Types ────────────────────────────────────────────────────────────────────

/** Normaliseret virksomhedsdata returneret til klienten */
export interface CVRSelskab {
  cvr: string;
  navn: string;
  adresse: string;
  postnr: string;
  by: string;
  telefon: string | null;
  email: string | null;
  branche: string | null;
  branchekode: number | null;
  selskabsform: string | null;
  startdato: string | null;
  slutdato: string | null;
  ansatte: number | null;
  reklamebeskyttet: boolean;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

/**
 * Finder den gældende (åbne) periode i et tidsbestemt array.
 * Returnerer det sidst kendte element som fallback.
 *
 * @param arr - Array med tidsbestemte objekter fra CVR ElasticSearch
 */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Mapper et råt ElasticSearch-hit til CVRSelskab.
 * Returnerer null hvis CVR-nummer mangler.
 *
 * @param hit - Rå ES-hit med _source.Vrvirksomhed
 */
function mapESHit(hit: Record<string, unknown>): CVRSelskab | null {
  const src = (hit._source as Record<string, unknown> | undefined)?.Vrvirksomhed as
    | Record<string, unknown>
    | undefined;
  if (!src) return null;

  const cvrNr = typeof src.cvrNummer === 'number' ? src.cvrNummer : null;
  if (!cvrNr) return null;

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
  const adresse = `${vejnavn} ${husnummerFra}${bogstavFra}`.trim();

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

  // ── Selskabsform ──
  const former = Array.isArray(src.virksomhedsform)
    ? (src.virksomhedsform as (Periodic & { langBeskrivelse?: string; kortBeskrivelse?: string })[])
    : [];
  const formNu = gyldigNu(former);
  const selskabsform = formNu?.langBeskrivelse ?? formNu?.kortBeskrivelse ?? null;

  // ── Start- og slutdato (fra livsforløb) ──
  const livsforloeb = Array.isArray(src.livsforloeb) ? (src.livsforloeb as Periodic[]) : [];
  // Startdato: tidligste gyldigFra i livsforløb (ellers stiftelsesDato)
  const stiftelse = typeof src.stiftelsesDato === 'string' ? src.stiftelsesDato : null;
  const fraer = livsforloeb
    .map((l) => l.periode?.gyldigFra)
    .filter((f): f is string => typeof f === 'string')
    .sort();
  const startdato = fraer[0] ?? stiftelse;
  // Slutdato: gyldigTil på lukket livsforløb (null = stadig aktiv)
  const slutdato =
    livsforloeb.find((l) => l.periode?.gyldigTil != null)?.periode?.gyldigTil ?? null;

  // ── Ansatte (seneste kvartal) ──
  const kvartal = Array.isArray(src.kvartalsbeskaeftigelse)
    ? (src.kvartalsbeskaeftigelse as (Periodic & { antalAnsatte?: number })[])
    : [];
  const senestKvartal = kvartal.length > 0 ? kvartal[kvartal.length - 1] : null;
  const ansatte = senestKvartal?.antalAnsatte ?? null;

  // ── Reklamebeskyttelse ──
  const reklamebeskyttet = Boolean(src.reklamebeskyttet);

  return {
    cvr: String(cvrNr),
    navn,
    adresse,
    postnr,
    by,
    telefon,
    email,
    branche,
    branchekode,
    selskabsform,
    startdato,
    slutdato,
    ansatte,
    reklamebeskyttet,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * GET /api/cvr/[cvr]
 * Henter virksomhedsdata for et CVR-nummer via Erhvervsstyrelsens CVR ES.
 *
 * @param _req - Ubrugt request-objekt
 * @param context - Route-context med CVR-nummer fra URL
 * @returns CVRSelskab eller { error } ved fejl
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ cvr: string }> }
): Promise<NextResponse> {
  const session = await resolveTenantId();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rawParams = await context.params;
  const paramResult = cvrParamSchema.safeParse(rawParams);
  if (!paramResult.success) {
    return NextResponse.json({ error: 'Ugyldigt CVR-nummer' }, { status: 400 });
  }
  const { cvr } = paramResult.data;

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json(
      { error: 'CVR-adgang ikke konfigureret (CVR_ES_USER/CVR_ES_PASS mangler)' },
      { status: 503 }
    );
  }

  const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

  const esQuery = {
    query: { term: { 'Vrvirksomhed.cvrNummer': Number(cvr) } },
    _source: [
      'Vrvirksomhed.cvrNummer',
      'Vrvirksomhed.navne',
      'Vrvirksomhed.beliggenhedsadresse',
      'Vrvirksomhed.telefonnummer',
      'Vrvirksomhed.emailadresse',
      'Vrvirksomhed.hovedbranche',
      'Vrvirksomhed.virksomhedsform',
      'Vrvirksomhed.livsforloeb',
      'Vrvirksomhed.stiftelsesDato',
      'Vrvirksomhed.kvartalsbeskaeftigelse',
      'Vrvirksomhed.reklamebeskyttet',
    ],
    size: 1,
  };

  try {
    const res = await fetch(proxyUrl(CVR_ES_BASE), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(8000),
      // Cachér resultater i 1 time — CVR-data ændres sjældent
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      logger.error('[CVR/cvr] ES svarede', res.status, await res.text().catch(() => ''));
      return NextResponse.json({ error: `CVR-opslag fejlede (ES ${res.status})` }, { status: 502 });
    }

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };

    const hit = data.hits?.hits?.[0];
    if (!hit) {
      return NextResponse.json({ error: 'CVR ikke fundet' }, { status: 404 });
    }

    const selskab = mapESHit(hit);
    if (!selskab) {
      return NextResponse.json({ error: 'CVR-data kunne ikke parses' }, { status: 502 });
    }

    return NextResponse.json(selskab, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    logger.error('[CVR/cvr] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'CVR-opslag mislykkedes' }, { status: 502 });
  }
}
