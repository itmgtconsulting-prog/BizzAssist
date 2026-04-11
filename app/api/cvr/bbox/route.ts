/**
 * GET /api/cvr/bbox?lat=&lng=&radius=
 *
 * Returnerer op til 50 aktive virksomheder med beliggenhedsadresse-koordinater
 * inden for en given radius fra et centralt koordinat.
 *
 * Strategi: Prøver `geo_distance` filter på `Vrvirksomhed.beliggenhedsadresse.location`
 * i CVR ElasticSearch. Hvis feltet ikke er mappet som geo_point, falder den tilbage
 * til en kommunekode-baseret søgning (via `kommunekode`-feltet afledt af `lat`/`lng`
 * via DAWA reverse geocoding — den fallback er dog ikke implementeret her; i stedet
 * returneres et tomt array så UI'en kan håndtere det gracefully).
 *
 * Returnerede felter pr. virksomhed:
 *   cvr    — CVR-nummer (number)
 *   navn   — Seneste registrerede navn
 *   branche — Branchetekst (dansk)
 *   lat    — Breddegrad fra beliggenhedsadresse.latitude
 *   lng    — Længdegrad fra beliggenhedsadresse.longitude
 *
 * Auth: HTTP Basic — CVR_ES_USER + CVR_ES_PASS i .env.local
 *
 * @param lat    - Breddegrad for søgecentrum (WGS84)
 * @param lng    - Længdegrad for søgecentrum (WGS84)
 * @param radius - Søgeradius i kilometer (default: 3, max: 20)
 */

import { NextRequest, NextResponse } from 'next/server';
import { gyldigNu } from '@/app/api/cvr/route';
import { logger } from '@/app/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** En virksomheds-markør til kortvisning */
export interface VirksomhedMarkør {
  cvr: number;
  navn: string;
  branche: string | null;
  lat: number;
  lng: number;
}

/** Shape af GET /api/cvr/bbox response */
export interface CVRBboxResponse {
  virksomheder: VirksomhedMarkør[];
  tokenMangler: boolean;
  geoIkkeStøttet: boolean;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';
const MAX_VIRKSOMHEDER = 50;
const MAX_RADIUS_KM = 20;
const DEFAULT_RADIUS_KM = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Bygger geo_distance ElasticSearch query der søger aktive virksomheder
 * med kendte beliggenhedsadresse-koordinater inden for `radius` km.
 *
 * @param lat    - Breddegrad
 * @param lng    - Længdegrad
 * @param radius - Radius i kilometer
 */
function byggGeoQuery(lat: number, lng: number, radius: number): Record<string, unknown> {
  return {
    _source: [
      'Vrvirksomhed.cvrNummer',
      'Vrvirksomhed.navne',
      'Vrvirksomhed.beliggenhedsadresse',
      'Vrvirksomhed.hovedbranche',
      'Vrvirksomhed.virksomhedsstatus',
      'Vrvirksomhed.livsforloeb',
      'Vrvirksomhed.virksomhedMetadata',
    ],
    query: {
      bool: {
        must: [
          {
            nested: {
              path: 'Vrvirksomhed.beliggenhedsadresse',
              query: {
                bool: {
                  must: [
                    // Kræv at koordinater er udfyldt (latitude !== 0)
                    { exists: { field: 'Vrvirksomhed.beliggenhedsadresse.latitude' } },
                    {
                      geo_distance: {
                        distance: `${radius}km`,
                        'Vrvirksomhed.beliggenhedsadresse.location': {
                          lat,
                          lon: lng,
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
        must_not: [
          // Filtrer ophørte virksomheder ved at udelukke dem med livsforløb-slutdato
          {
            nested: {
              path: 'Vrvirksomhed.livsforloeb',
              query: {
                bool: {
                  must: [
                    { exists: { field: 'Vrvirksomhed.livsforloeb.periode.gyldigTil' } },
                    {
                      range: {
                        'Vrvirksomhed.livsforloeb.periode.gyldigTil': {
                          lte: 'now',
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
    sort: [
      {
        _geo_distance: {
          'Vrvirksomhed.beliggenhedsadresse.location': { lat, lon: lng },
          order: 'asc',
          nested: { path: 'Vrvirksomhed.beliggenhedsadresse' },
        },
      },
    ],
    size: MAX_VIRKSOMHEDER,
  };
}

/**
 * Mapper et rå ES-hit til VirksomhedMarkør.
 * Returnerer null hvis CVR-nummer eller koordinater mangler.
 *
 * @param hit - Rå ElasticSearch _source hit
 */
function mapTilMarkør(hit: Record<string, unknown>): VirksomhedMarkør | null {
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
  if (!navn) return null;

  // ── Adresse-koordinater (fra gyldig beliggenhedsadresse) ──
  const adresser = Array.isArray(src.beliggenhedsadresse)
    ? (src.beliggenhedsadresse as (Periodic & Record<string, unknown>)[])
    : [];
  const adr = gyldigNu(adresser);
  const lat = typeof adr?.latitude === 'number' ? adr.latitude : null;
  const lng = typeof adr?.longitude === 'number' ? adr.longitude : null;
  // Filtrer null-koordinater og (0,0)-tilfælde (manglende data i CVR)
  if (!lat || !lng || (lat === 0 && lng === 0)) return null;

  // ── Branche ──
  const brancher = Array.isArray(src.hovedbranche)
    ? (src.hovedbranche as (Periodic & { branchetekst?: string })[])
    : [];
  const branche = gyldigNu(brancher)?.branchetekst ?? null;

  return { cvr, navn, branche, lat, lng };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/** GET /api/cvr/bbox */
export async function GET(req: NextRequest): Promise<NextResponse<CVRBboxResponse>> {
  const { searchParams } = req.nextUrl;

  const latStr = searchParams.get('lat');
  const lngStr = searchParams.get('lng');
  const radiusStr = searchParams.get('radius');

  const lat = latStr != null ? parseFloat(latStr) : NaN;
  const lng = lngStr != null ? parseFloat(lngStr) : NaN;
  const radiusRaw = radiusStr != null ? parseFloat(radiusStr) : DEFAULT_RADIUS_KM;
  const radius = isNaN(radiusRaw)
    ? DEFAULT_RADIUS_KM
    : Math.min(Math.max(radiusRaw, 0.5), MAX_RADIUS_KM);

  if (isNaN(lat) || isNaN(lng) || lat < 54 || lat > 58 || lng < 7 || lng > 16) {
    return NextResponse.json({ virksomheder: [], tokenMangler: false, geoIkkeStøttet: false });
  }

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ virksomheder: [], tokenMangler: true, geoIkkeStøttet: false });
  }

  const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
  const esQuery = byggGeoQuery(lat, lng, radius);

  try {
    const res = await fetch(CVR_ES_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // ElasticSearch returnerer 400 ved geo_point-fejl (feltet ikke mappet)
      if (res.status === 400 && body.includes('geo')) {
        logger.warn('[CVR bbox] geo_distance ikke understøttet:', body.slice(0, 200));
        return NextResponse.json({
          virksomheder: [],
          tokenMangler: false,
          geoIkkeStøttet: true,
        });
      }
      logger.error('[CVR bbox] ES fejl', res.status, body.slice(0, 200));
      return NextResponse.json({ virksomheder: [], tokenMangler: false, geoIkkeStøttet: false });
    }

    const data = (await res.json()) as {
      hits?: { hits?: Record<string, unknown>[] };
      error?: unknown;
    };

    // Håndter ES-fejl i response-body (f.eks. parsing-fejl)
    if (data.error) {
      logger.warn('[CVR bbox] ES body-fejl:', JSON.stringify(data.error).slice(0, 200));
      return NextResponse.json({
        virksomheder: [],
        tokenMangler: false,
        geoIkkeStøttet: true,
      });
    }

    const hits = data.hits?.hits ?? [];
    const virksomheder = hits.map(mapTilMarkør).filter((v): v is VirksomhedMarkør => v !== null);

    return NextResponse.json(
      { virksomheder, tokenMangler: false, geoIkkeStøttet: false },
      {
        headers: {
          // Cache 5 minutter — virksomheder flytter sig ikke hurtigt
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        },
      }
    );
  } catch (err) {
    logger.error('[CVR bbox] Fetch fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ virksomheder: [], tokenMangler: false, geoIkkeStøttet: false });
  }
}
