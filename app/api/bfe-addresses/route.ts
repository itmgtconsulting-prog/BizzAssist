/**
 * GET /api/bfe-addresses?bfes=1,2,3
 *
 * BIZZ-581: Lightweight batch-endpoint der beriger BFE-numre med adresse +
 * dawaId så de kan vises som korrekte ejendomsbokse i diagrammer.
 * Bruges når BFE-numre kommer fra bulk-data (BIZZ-534 person-bridge) uden
 * adresse-information.
 *
 * Returnerer: { [bfe]: { adresse, postnr, by, kommune, dawaId, ejendomstype, etage, doer } }
 *
 * Hver BFE-opslag bruger den eksisterende DAWA→VP-pipeline fra
 * ejendomme-by-owner. Cache: 24 timer.
 *
 * @module api/bfe-addresses
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Maks BFE'er per kald — beskytter mod misbrug */
const MAX_BATCH = 50;

const querySchema = z.object({
  bfes: z.string().regex(/^[\d,]+$/, 'bfes skal være komma-separeret tal'),
});

interface AdresseRow {
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  kommune: string | null;
  dawaId: string | null;
  ejendomstype: string | null;
  etage: string | null;
  doer: string | null;
}

const empty = (): AdresseRow => ({
  adresse: null,
  postnr: null,
  by: null,
  kommune: null,
  dawaId: null,
  ejendomstype: null,
  etage: null,
  doer: null,
});

/**
 * Resolver én BFE → adresse via DAWA /bfe/{bfe} (samlet ejendom) eller
 * VP-fallback (ejerlejligheder hvor DAWA returnerer 404).
 */
async function resolveOne(bfe: string): Promise<AdresseRow> {
  const result = empty();

  // Trin 1: DAWA /bfe/{bfe} — virker for samlet fast ejendom
  try {
    const res = await fetch(`${DAWA_BASE_URL}/bfe/${bfe}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 86400 },
    });
    if (res.ok) {
      const json = (await res.json()) as {
        ejendomstype?: string;
        beliggenhedsadresse?: {
          id?: string;
          vejnavn?: string;
          husnr?: string;
          etage?: string;
          dør?: string;
          postnr?: string;
          postnrnavn?: string;
          kommunenavn?: string;
        };
      };
      const bel = json.beliggenhedsadresse;
      if (bel?.vejnavn) {
        result.adresse = `${bel.vejnavn} ${bel.husnr ?? ''}`.trim();
        result.postnr = bel.postnr ?? null;
        result.by = bel.postnrnavn ?? null;
        result.kommune = bel.kommunenavn ?? null;
        result.dawaId = bel.id ?? null;
        result.ejendomstype = json.ejendomstype ?? null;
        result.etage = bel.etage ?? null;
        result.doer = bel.dør ?? null;
        return result;
      }
    }
  } catch {
    // Fall through til VP
  }

  // Trin 2: VP-fallback for ejerlejligheder (DAWA /bfe/{bfe} returnerer 404)
  try {
    const vpRes = await fetch(
      'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({
          query: { term: { bfeNumbers: parseInt(bfe, 10) } },
          size: 1,
          _source: [
            'roadName',
            'houseNumber',
            'zipcode',
            'postDistrict',
            'adgangsAdresseID',
            'adresseID',
            'floor',
            'door',
            'juridiskKategori',
          ],
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (vpRes.ok) {
      const data = (await vpRes.json()) as {
        hits?: {
          hits?: Array<{
            _source?: {
              roadName?: string;
              houseNumber?: string;
              zipcode?: string;
              postDistrict?: string;
              adgangsAdresseID?: string;
              adresseID?: string;
              floor?: string;
              door?: string;
              juridiskKategori?: string;
            };
          }>;
        };
      };
      const src = data.hits?.hits?.[0]?._source;
      if (src?.roadName) {
        result.adresse = `${src.roadName} ${src.houseNumber ?? ''}`.trim();
        result.postnr = src.zipcode ?? null;
        result.by = src.postDistrict ?? null;
        result.ejendomstype = src.juridiskKategori ?? null;
        result.etage = src.floor && src.floor.length > 0 ? src.floor : null;
        result.doer = src.door && src.door.length > 0 ? src.door : null;
        // Foretræk adresseID for ejerlejligheder (etage/dør), ellers
        // adgangsAdresseID. Begge må valideres mod DAWA — men her behøver
        // vi blot en best-effort link, så vi tager hvad VP giver.
        result.dawaId =
          (result.etage ? src.adresseID : src.adgangsAdresseID) ??
          src.adgangsAdresseID ??
          src.adresseID ??
          null;
      }
    }
  } catch {
    // Returnér tom record
  }

  return result;
}

/**
 * GET /api/bfe-addresses
 * Batch-resolve BFE-numre → adresse + dawaId.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) return parsed.response;
  const { bfes } = parsed.data;

  const list = bfes.split(',').filter(Boolean).slice(0, MAX_BATCH);

  try {
    const results = await Promise.all(list.map((b) => resolveOne(b)));
    const out: Record<string, AdresseRow> = {};
    for (let i = 0; i < list.length; i++) out[list[i]] = results[i];

    return NextResponse.json(out, {
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=21600',
      },
    });
  } catch (err) {
    logger.error('[bfe-addresses] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
