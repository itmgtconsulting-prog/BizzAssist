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
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

/** Zod schema for /api/cvr query params */
const querySchema = z.object({
  vejnavn: z.string().min(1),
  husnr: z.string().optional(),
  postnr: z.string().optional(),
  etage: z.string().optional(),
  doer: z.string().optional(),
});

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape af GET /api/cvr response */
export interface CVRResponse {
  virksomheder: CVRVirksomhed[];
  tokenMangler: boolean;
  /** True når CVR ElasticSearch API er utilgængeligt (timeout/netværksfejl) */
  apiDown?: boolean;
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
  /** Om virksomhedens NUVÆRENDE adresse matcher den søgte adresse.
   *  false = virksomheden var engang på adressen men er flyttet. */
  påAdressen: boolean;
  /** ISO-dato for hvornår virksomheden flyttede TIL den søgte adresse */
  adresseFra: string | null;
  /** ISO-dato for hvornår virksomheden flyttede FRA den søgte adresse (null = stadig der) */
  adresseTil: string | null;
}

// ─── Config ───────────────────────────────────────────────────────────────────

// NOTE: distribution.virk.dk's HTTPS certificate causes fetch failures on some environments
// (Windows dev, certain Node versions) due to intermediate certificate chain issues.
// Using HTTP here — Basic Auth credentials are low-risk (free public data service).
// BIZZ-176: revisit HTTPS when certificate chain is stable.
const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

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

  // ── Status (NORMAL, AKTIV eller tom = aktiv; tjek også livsforløb + sammensatStatus) ──
  const statusser = Array.isArray(src.virksomhedsstatus)
    ? (src.virksomhedsstatus as (Periodic & {
        statuskode?: string;
        status?: string;
        gyldigFra?: string;
      })[])
    : [];
  const aktuelStatus = gyldigNu(statusser);
  const statusVal = aktuelStatus?.statuskode ?? aktuelStatus?.status ?? '';
  const meta = src.virksomhedMetadata as Record<string, unknown> | undefined;
  const sammensatStatus = typeof meta?.sammensatStatus === 'string' ? meta.sammensatStatus : '';
  const livsforloeb = Array.isArray(src.livsforloeb)
    ? (src.livsforloeb as { periode?: { gyldigTil?: string | null } }[])
    : [];
  const aktueltForloeb = gyldigNu(livsforloeb);
  const harSlutdato = aktueltForloeb?.periode?.gyldigTil != null;
  const aktiv =
    (statusVal === 'NORMAL' || statusVal === 'AKTIV' || statusVal === '') &&
    sammensatStatus !== 'Ophørt' &&
    !harSlutdato;
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
    påAdressen: true, // Overskrives i route handler efter mapping
    adresseFra: null,
    adresseTil: null,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    // Missing vejnavn → empty result (backwards compatible)
    return NextResponse.json({ virksomheder: [], tokenMangler: false }, { status: 200 });
  }
  const { vejnavn, husnr = '', postnr = '', etage = '', doer = '' } = parsed.data;

  // Returner tokenMangler-flag hvis credentials ikke er sat
  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ virksomheder: [], tokenMangler: true }, { status: 200 });
  }

  const { nr, bogstav } = parseHusnr(husnr);
  const postnrInt = parseInt(postnr, 10);

  // ── Byg adressefiltre for beliggenhedsadresse (juridisk adresse) ──
  const beligFiltre: unknown[] = [
    { match: { 'Vrvirksomhed.beliggenhedsadresse.vejnavn': vejnavn } },
  ];
  if (nr != null) {
    beligFiltre.push({
      term: { 'Vrvirksomhed.beliggenhedsadresse.husnummerFra': nr },
    });
  }
  if (bogstav) {
    beligFiltre.push({
      match: { 'Vrvirksomhed.beliggenhedsadresse.bogstavFra': bogstav },
    });
  }
  if (!isNaN(postnrInt)) {
    beligFiltre.push({
      term: { 'Vrvirksomhed.beliggenhedsadresse.postnummer': postnrInt },
    });
  }
  // Etage + dør filter for ejerlejligheder
  if (etage) {
    beligFiltre.push({
      match: { 'Vrvirksomhed.beliggenhedsadresse.etage': etage },
    });
  }
  if (doer) {
    beligFiltre.push({
      match: { 'Vrvirksomhed.beliggenhedsadresse.sidedoer': doer },
    });
  }
  // Hovedejendom: exclude companies with specific apartment address (etage/dør)
  if (!etage && !doer) {
    beligFiltre.push({
      bool: {
        must_not: [{ exists: { field: 'Vrvirksomhed.beliggenhedsadresse.etage' } }],
      },
    });
  }

  // ── Byg adressefiltre for P-enheder (produktionsenhed-adresser) ──
  const penhedFiltre: unknown[] = [
    { match: { 'Vrvirksomhed.penheder.beliggenhedsadresse.vejnavn': vejnavn } },
  ];
  if (nr != null) {
    penhedFiltre.push({
      term: { 'Vrvirksomhed.penheder.beliggenhedsadresse.husnummerFra': nr },
    });
  }
  if (bogstav) {
    penhedFiltre.push({
      match: { 'Vrvirksomhed.penheder.beliggenhedsadresse.bogstavFra': bogstav },
    });
  }
  if (!isNaN(postnrInt)) {
    penhedFiltre.push({
      term: { 'Vrvirksomhed.penheder.beliggenhedsadresse.postnummer': postnrInt },
    });
  }
  if (etage) {
    penhedFiltre.push({
      match: { 'Vrvirksomhed.penheder.beliggenhedsadresse.etage': etage },
    });
  }
  if (doer) {
    penhedFiltre.push({
      match: { 'Vrvirksomhed.penheder.beliggenhedsadresse.sidedoer': doer },
    });
  }
  // Hovedejendom: exclude P-enheder with specific apartment address (etage/dør)
  if (!etage && !doer) {
    penhedFiltre.push({
      bool: {
        must_not: [{ exists: { field: 'Vrvirksomhed.penheder.beliggenhedsadresse.etage' } }],
      },
    });
  }

  // ── Søg på både juridisk adresse OG P-enhed-adresser (OR) ──
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
      'Vrvirksomhed.livsforloeb',
      'Vrvirksomhed.virksomhedMetadata',
      'Vrvirksomhed.penheder',
    ],
    query: {
      bool: {
        should: [
          // Match på juridisk beliggenhedsadresse
          {
            nested: {
              path: 'Vrvirksomhed.beliggenhedsadresse',
              query: { bool: { must: beligFiltre } },
            },
          },
          // Match på P-enhed-adresse (produktionsenheder)
          // NB: penheder er nested, men beliggenhedsadresse under penheder er IKKE nested
          // — derfor single-nested query med fulde field-paths
          {
            nested: {
              path: 'Vrvirksomhed.penheder',
              query: { bool: { must: penhedFiltre } },
            },
          },
        ],
        minimum_should_match: 1,
      },
    },
    size: 50,
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
    });

    if (!res.ok) {
      logger.error('[CVR] ES returned', res.status, await res.text().catch(() => ''));
      return NextResponse.json({ virksomheder: [], tokenMangler: false }, { status: 200 });
    }

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };

    const hits = data.hits?.hits ?? [];
    const mapped = hits.map(mapESHit).filter((v): v is CVRVirksomhed => v !== null);

    // Deduplikér (en virksomhed kan matche på både juridisk adresse og P-enhed)
    // Behold raw hit reference for adresseperiode-opslag
    const hitsByCvr = new Map<number, Record<string, unknown>>();
    const seen = new Set<number>();
    const virksomheder: CVRVirksomhed[] = [];
    for (let i = 0; i < mapped.length; i++) {
      const v = mapped[i];
      if (v && !seen.has(v.cvr)) {
        seen.add(v.cvr);
        virksomheder.push(v);
        hitsByCvr.set(v.cvr, hits[i]);
      }
    }

    // Beregn påAdressen + adresseFra/adresseTil fra ALLE adresseperioder i ES-hit.
    // Tjek alle beliggenhedsadresse-perioder der matcher den søgte adresse.
    // En periode med gyldigTil == null = virksomheden er STADIG på adressen.
    const søgtHusnr = `${nr ?? ''}${bogstav ?? ''}`.trim().toUpperCase();
    const søgtVejnavnLower = vejnavn.toLowerCase();

    for (const v of virksomheder) {
      const rawHit = hitsByCvr.get(v.cvr);
      if (!rawHit) continue;

      const src = (rawHit._source as Record<string, unknown> | undefined)?.Vrvirksomhed as
        | Record<string, unknown>
        | undefined;
      if (!src) continue;

      type AdressePeriode = {
        periode?: { gyldigFra?: string | null; gyldigTil?: string | null };
      } & Record<string, unknown>;
      const adresser = Array.isArray(src.beliggenhedsadresse)
        ? (src.beliggenhedsadresse as AdressePeriode[])
        : [];

      // Find adresseperioder der matcher den søgte adresse
      const matchende = adresser.filter((a) => {
        const aVej = typeof a.vejnavn === 'string' ? a.vejnavn.toLowerCase() : '';
        const aHusnr = typeof a.husnummerFra === 'number' ? String(a.husnummerFra) : '';
        const aBogstav = typeof a.bogstavFra === 'string' ? a.bogstavFra : '';
        const aPostnr = typeof a.postnummer === 'number' ? String(a.postnummer) : '';
        const aFullHusnr = `${aHusnr}${aBogstav}`.trim().toUpperCase();
        return aVej === søgtVejnavnLower && aFullHusnr === søgtHusnr && aPostnr === postnr;
      });

      if (matchende.length > 0) {
        // Virksomheden er/var på adressen via beliggenhedsadresse
        v.påAdressen = matchende.some((a) => a.periode?.gyldigTil == null);

        // Tidligste gyldigFra blandt matchende perioder
        const fraer = matchende
          .map((a) => a.periode?.gyldigFra)
          .filter((f): f is string => typeof f === 'string')
          .sort();
        v.adresseFra = fraer[0] ?? null;

        // Seneste gyldigTil (null = stadig der)
        if (v.påAdressen) {
          v.adresseTil = null;
        } else {
          const tiler = matchende
            .map((a) => a.periode?.gyldigTil)
            .filter((t): t is string => typeof t === 'string')
            .sort()
            .reverse();
          v.adresseTil = tiler[0] ?? null;
        }
      } else {
        // Ingen matchende beliggenhedsadresse — matchede via P-enhed
        v.påAdressen = true;
        v.adresseFra = null;
        v.adresseTil = null;
      }
    }

    // Sortering: på adressen + aktive først, derefter flyttede/ophørte
    virksomheder.sort((a, b) => {
      // 1. Aktive på adressen øverst
      const aScore = a.aktiv && a.påAdressen ? 2 : a.aktiv ? 1 : 0;
      const bScore = b.aktiv && b.påAdressen ? 2 : b.aktiv ? 1 : 0;
      return bScore - aScore;
    });

    return NextResponse.json(
      { virksomheder, tokenMangler: false },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=300',
        },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // TimeoutError or network failure — flag apiDown so the UI can show a proper message
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    logger.error('[CVR] Fetch error:', msg);
    return NextResponse.json(
      { virksomheder: [], tokenMangler: false, apiDown: isTimeout || msg.includes('timeout') },
      { status: 200 }
    );
  }
}
