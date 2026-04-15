/**
 * GET /api/person-search?q=<query>
 *
 * Søger efter personer (deltagere) i CVR-registret via Erhvervsstyrelsens ElasticSearch.
 * Bruger deltager-indexet til at finde navnematch med phrase-prefix + fuzzy strategier.
 * Returnerer kompakte resultater designet til autocomplete / søgeforslag.
 *
 * @param q - Søgetekst (min. 2 tegn)
 * @returns { results: PersonSearchResult[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { proxyUrl } from '@/app/lib/dfProxy';
import { resolveTenantId } from '@/lib/api/auth';

/** Zod schema for /api/person-search query params */
const querySchema = z.object({ q: z.string().trim().min(2).max(500) });

// ─── Types ────────────────────────────────────────────────────────────────────

/** Kompakt rolle-info for en person */
export interface PersonRolleInfo {
  /** Virksomhedsnavn */
  virksomhedNavn: string;
  /** Rolle (f.eks. "Direktør", "Stifter", "Reel ejer") */
  rolle: string | null;
}

/** Kompakt personresultat til søgeforslag */
export interface PersonSearchResult {
  /** Enhedsnummer fra CVR */
  enhedsNummer: number;
  /** Personens navn */
  name: string;
  /** Om enheden er en virksomhed (true) eller person (false) */
  erVirksomhed: boolean;
  /** Antal virksomheder personen er tilknyttet (estimat fra søgeresultat) */
  antalVirksomheder: number;
  /** Op til 3 roller/virksomheder personen er tilknyttet */
  roller: PersonRolleInfo[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent/deltager/_search';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

// ─── ES helpers ─────────────────────────────────────────────────────────────

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

/**
 * Finder den gældende (åbne) periode i et tidsbestemt array.
 *
 * @param arr - Array med tidsbestemte objekter
 */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/**
 * Mapper et ES-hit fra deltager-indexet til en PersonSearchResult.
 *
 * @param hit - Rå ES-hit med _source.Vrdeltagerperson
 * @returns PersonSearchResult eller null
 */
function mapHit(hit: Record<string, unknown>): PersonSearchResult | null {
  const src = hit._source as Record<string, unknown> | undefined;
  if (!src) return null;

  // Deltager kan være Vrdeltagerperson eller Vrdeltagerperson (ES bruger denne key)
  const deltager = (src.Vrdeltagerperson ?? src.VrDeltager) as Record<string, unknown> | undefined;
  if (!deltager) return null;

  const enhedsNummer = typeof deltager.enhedsNummer === 'number' ? deltager.enhedsNummer : null;
  if (!enhedsNummer) return null;

  // Navn
  const navne = Array.isArray(deltager.navne)
    ? (deltager.navne as (Periodic & { navn?: string })[])
    : [];
  const name = gyldigNu(navne)?.navn ?? '';
  if (!name) return null;

  // Enhedstype
  const enhedstype = typeof deltager.enhedstype === 'string' ? deltager.enhedstype : '';
  const erVirksomhed = enhedstype !== 'PERSON';

  // Antal virksomheder (fra virksomhedSummarisk)
  const summarisk = Array.isArray(deltager.virksomhedSummarisk) ? deltager.virksomhedSummarisk : [];
  const antalVirksomheder = summarisk.length;

  // Roller — fra virksomhedSummariskRelation (op til 3 aktive virksomheder)
  const relationer = Array.isArray(deltager.virksomhedSummariskRelation)
    ? (deltager.virksomhedSummariskRelation as Record<string, unknown>[])
    : [];

  const roller: PersonRolleInfo[] = [];
  for (const rel of relationer) {
    if (roller.length >= 3) break;

    // Virksomhedsnavn
    const virk = rel.virksomhed as Record<string, unknown> | undefined;
    if (!virk) continue;
    const virkNavne = Array.isArray(virk.navne)
      ? (virk.navne as (Periodic & { navn?: string })[])
      : [];
    const virkNavn = gyldigNu(virkNavne)?.navn ?? null;
    if (!virkNavn) continue;

    // Tjek om virksomheden stadig er aktiv (livsforloeb åben)
    const livsforloeb = Array.isArray(virk.livsforloeb) ? (virk.livsforloeb as Periodic[]) : [];
    const aktivLiv = livsforloeb.some((l) => l.periode?.gyldigTil == null);
    if (!aktivLiv) continue;

    // Rolle — fra organisationer → medlemsData → FUNKTION attribut
    let rolleNavn: string | null = null;
    const orgs = Array.isArray(rel.organisationer)
      ? (rel.organisationer as Record<string, unknown>[])
      : [];
    for (const org of orgs) {
      const hovedtype = typeof org.hovedtype === 'string' ? org.hovedtype : '';
      // Spring REGISTER (ejerregister) over — vis kun ledelsesroller og stiftere
      if (hovedtype === 'REGISTER') continue;

      const medlemsData = Array.isArray(org.medlemsData)
        ? (org.medlemsData as Record<string, unknown>[])
        : [];
      for (const md of medlemsData) {
        const attrs = Array.isArray(md.attributter)
          ? (md.attributter as Record<string, unknown>[])
          : [];
        for (const attr of attrs) {
          if (attr.type !== 'FUNKTION') continue;
          const vaerdier = Array.isArray(attr.vaerdier)
            ? (attr.vaerdier as (Periodic & { vaerdi?: string })[])
            : [];
          // Find aktiv funktion
          const aktivFunktion =
            vaerdier.find((v) => v.periode?.gyldigTil == null) ?? vaerdier[vaerdier.length - 1];
          if (aktivFunktion?.vaerdi) {
            // Prettify: "ADM. DIR." → "Adm. dir.", "STIFTERE" → "Stifter" etc.
            const raw = aktivFunktion.vaerdi;
            rolleNavn = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
            break;
          }
        }
        if (rolleNavn) break;
      }
      if (rolleNavn) break;
    }

    roller.push({ virksomhedNavn: virkNavn, rolle: rolleNavn });
  }

  return { enhedsNummer, name, erVirksomhed, antalVirksomheder, roller };
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

  // Byg ES-query med multiple match-strategier for deltager-indexet
  const esQuery = {
    _source: [
      'Vrdeltagerperson.enhedsNummer',
      'Vrdeltagerperson.navne',
      'Vrdeltagerperson.enhedstype',
      'Vrdeltagerperson.virksomhedSummarisk',
      'Vrdeltagerperson.virksomhedSummariskRelation',
    ],
    query: {
      nested: {
        path: 'Vrdeltagerperson.navne',
        query: {
          bool: {
            should: [
              // Eksakt phrase match
              { match_phrase: { 'Vrdeltagerperson.navne.navn': { query: q, boost: 5 } } },
              // Prefix-match — fanger delvis input
              { match_phrase_prefix: { 'Vrdeltagerperson.navne.navn': { query: q, boost: 4 } } },
              // Contains-match via wildcard
              {
                wildcard: {
                  'Vrdeltagerperson.navne.navn': { value: `*${q.toLowerCase()}*`, boost: 3 },
                },
              },
              // Standard match
              { match: { 'Vrdeltagerperson.navne.navn': { query: q, operator: 'and', boost: 2 } } },
              // Fuzzy match
              {
                match: {
                  'Vrdeltagerperson.navne.navn': {
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
      logger.error('[person-search] ES returned', res.status);
      return NextResponse.json({ results: [] });
    }

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
    };

    const hits = data.hits?.hits ?? [];
    const results: PersonSearchResult[] = [];
    const seen = new Set<number>();

    for (const hit of hits) {
      const mapped = mapHit(hit);
      if (mapped && !seen.has(mapped.enhedsNummer)) {
        seen.add(mapped.enhedsNummer);
        results.push(mapped);
      }
    }

    return NextResponse.json(
      { results },
      {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=120' },
      }
    );
  } catch (err) {
    logger.error('[person-search] Error:', err instanceof Error ? err.message : err);
    return NextResponse.json({ results: [] });
  }
}
