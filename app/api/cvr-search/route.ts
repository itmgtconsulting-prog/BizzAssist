/**
 * GET /api/cvr-search?q=<query>
 *
 * Letvægts-søgning i CVR-registret der returnerer multiple virksomheder.
 * Bruger Erhvervsstyrelsens ElasticSearch med phrase-prefix, match og fuzzy
 * strategier for at fange delvis-match (f.eks. "cerami" → "Ceramica ApS").
 *
 * Returnerer kompakt data (ingen produktionsenheder, ejere, historik etc.)
 * — designet til autocomplete / søgeforslag i virksomheds-listesiden.
 *
 * @param q - Søgetekst (min. 2 tegn)
 * @returns { results: CVRSearchResult[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { proxyUrl, proxyHeaders } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';

/** Zod schema for /api/cvr-search query params */
const querySchema = z.object({ q: z.string().trim().min(2).max(500) });

// ─── Types ────────────────────────────────────────────────────────────────────

/** Kompakt virksomhedsresultat til søgeforslag */
export interface CVRSearchResult {
  /** CVR-nummer */
  cvr: number;
  /** Virksomhedsnavn */
  name: string;
  /** Adresse (vejnavn + husnr) */
  address: string;
  /** Postnummer */
  zipcode: string;
  /** By */
  city: string;
  /** Branchetekst */
  industry: string | null;
  /** Virksomhedsform (ApS, A/S etc.) */
  companyType: string | null;
  /** Om virksomheden er aktiv */
  active: boolean;
  /** Ophørsdato (ISO), null hvis aktiv */
  enddate: string | null;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

// ─── ES helpers ─────────────────────────────────────────────────────────────

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

/**
 * Finder den gældende (åbne) periode i et tidsbestemt array.
 *
 * @param arr - Array med tidsbestemte objekter fra CVR ES
 */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Mapper et ES-hit til en kompakt CVRSearchResult.
 *
 * @param hit - Rå ES-hit med _source.Vrvirksomhed
 * @returns CVRSearchResult eller null
 */
function mapHit(hit: Record<string, unknown>): CVRSearchResult | null {
  const src = (hit._source as Record<string, unknown> | undefined)?.Vrvirksomhed as
    | Record<string, unknown>
    | undefined;
  if (!src) return null;

  const cvr = typeof src.cvrNummer === 'number' ? src.cvrNummer : null;
  if (!cvr) return null;

  // Navn
  const navne = Array.isArray(src.navne) ? (src.navne as (Periodic & { navn?: string })[]) : [];
  const name = gyldigNu(navne)?.navn ?? '';

  // Adresse
  const adresser = Array.isArray(src.beliggenhedsadresse)
    ? (src.beliggenhedsadresse as (Periodic & Record<string, unknown>)[])
    : [];
  const adr = gyldigNu(adresser);
  const vejnavn = typeof adr?.vejnavn === 'string' ? adr.vejnavn : '';
  const husnummerFra = typeof adr?.husnummerFra === 'number' ? String(adr.husnummerFra) : '';
  const bogstavFra = typeof adr?.bogstavFra === 'string' ? adr.bogstavFra : '';
  const postnr = typeof adr?.postnummer === 'number' ? String(adr.postnummer) : '';
  const by = typeof adr?.postdistrikt === 'string' ? adr.postdistrikt : '';
  const address = `${vejnavn} ${husnummerFra}${bogstavFra}`.trim();

  // Branche
  const brancher = Array.isArray(src.hovedbranche)
    ? (src.hovedbranche as (Periodic & { branchetekst?: string })[])
    : [];
  const industry = gyldigNu(brancher)?.branchetekst ?? null;

  // Virksomhedsform
  const former = Array.isArray(src.virksomhedsform)
    ? (src.virksomhedsform as (Periodic & { kortBeskrivelse?: string })[])
    : [];
  const companyType = gyldigNu(former)?.kortBeskrivelse ?? null;

  // Status
  const statusser = Array.isArray(src.virksomhedsstatus)
    ? (src.virksomhedsstatus as (Periodic & { statuskode?: string; status?: string })[])
    : [];
  const aktuelStatus = gyldigNu(statusser);
  const statusVal = aktuelStatus?.statuskode ?? aktuelStatus?.status ?? '';
  const meta = src.virksomhedMetadata as Record<string, unknown> | undefined;
  const sammensatStatus = typeof meta?.sammensatStatus === 'string' ? meta.sammensatStatus : '';
  const livsforloeb = Array.isArray(src.livsforloeb)
    ? (src.livsforloeb as { periode?: { gyldigTil?: string | null } }[])
    : [];
  const harSlutdato = livsforloeb.some((l) => l.periode?.gyldigTil != null);
  const active =
    (statusVal === 'NORMAL' || statusVal === 'AKTIV' || statusVal === '') &&
    sammensatStatus !== 'Ophørt' &&
    !harSlutdato;

  // Ophørsdato
  const slutdato =
    livsforloeb.find((l) => l.periode?.gyldigTil != null)?.periode?.gyldigTil ?? null;

  return {
    cvr,
    name,
    address,
    zipcode: postnr,
    city: by,
    industry,
    companyType,
    active,
    enddate: slutdato,
  };
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Rate limit: protect paid CVR ES credentials from abuse
  const limited = await checkRateLimit(req, rateLimit);
  if (limited) return limited;
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ results: [] });
  }
  const { q } = parsed.data;

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ results: [], error: 'CVR-adgang ikke konfigureret' });
  }

  // Byg ES-query med multiple match-strategier for god dækning
  const esQuery = {
    _source: [
      'Vrvirksomhed.cvrNummer',
      'Vrvirksomhed.navne',
      'Vrvirksomhed.beliggenhedsadresse',
      'Vrvirksomhed.hovedbranche',
      'Vrvirksomhed.virksomhedsform',
      'Vrvirksomhed.virksomhedsstatus',
      'Vrvirksomhed.livsforloeb',
      'Vrvirksomhed.virksomhedMetadata',
    ],
    query: {
      nested: {
        path: 'Vrvirksomhed.navne',
        query: {
          bool: {
            should: [
              // Eksakt phrase match — højest score
              { match_phrase: { 'Vrvirksomhed.navne.navn': { query: q, boost: 5 } } },
              // Prefix-match — fanger "cerami" → "Ceramica ApS"
              { match_phrase_prefix: { 'Vrvirksomhed.navne.navn': { query: q, boost: 4 } } },
              // Wildcard contains-match — fanger "cerami" midt i navnet
              {
                wildcard: {
                  'Vrvirksomhed.navne.navn': { value: `*${q.toLowerCase()}*`, boost: 3 },
                },
              },
              // Standard match med alle ord
              { match: { 'Vrvirksomhed.navne.navn': { query: q, operator: 'and', boost: 2 } } },
              // Fuzzy match — fanger stavefejl
              {
                match: {
                  'Vrvirksomhed.navne.navn': {
                    query: q,
                    fuzziness: 'AUTO',
                    operator: 'or',
                    boost: 1,
                  },
                },
              },
            ],
            minimum_should_match: 1,
          },
        },
      },
    },
    size: 20,
  };

  try {
    const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

    const res = await fetch(proxyUrl(CVR_ES_BASE), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      logger.error('[cvr-search] ES returned', res.status);
      return NextResponse.json({ results: [] });
    }

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };

    const hits = data.hits?.hits ?? [];
    const results: CVRSearchResult[] = [];
    const seen = new Set<number>();

    for (const hit of hits) {
      const mapped = mapHit(hit);
      if (mapped && !seen.has(mapped.cvr)) {
        seen.add(mapped.cvr);
        results.push(mapped);
      }
    }

    // Sortér: aktive først, derefter ophørte
    results.sort((a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1));

    return NextResponse.json(
      { results },
      {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=120' },
      }
    );
  } catch (err) {
    logger.error('[cvr-search] Error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ results: [] });
  }
}
