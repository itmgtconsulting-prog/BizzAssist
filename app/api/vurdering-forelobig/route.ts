/**
 * GET /api/vurdering-forelobig
 *
 * Henter forelobige ejendomsvurderinger fra Vurderingsportalens Elasticsearch API.
 *
 * Soegeparametre (prioriteret raekkefoelge):
 *   1. ?adresseId=UUID         - soeg direkte paa adgangsAdresseID / adresseID
 *   2. ?kommunenr=XXX&vejnavn=YYY&husnr=ZZZ  - adressesog via kommune/vej/husnr
 *   3. ?bfeNummer=XXX          - opslag BFE-nummer (soeger direkte i bfeNumbers-felt)
 *
 * Returnerer: ForelobigVurderingResponse med array af forelobige vurderinger
 * sorteret nyeste vurderingsaar forst.
 *
 * Cache: 24 timer + 1 time stale-while-revalidate.
 *
 * @param request - Next.js request med soegeparametre
 * @returns ForelobigVurderingResponse
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ───────────────────────────────────────────────────────────────────

/** En enkelt forelobig vurdering fra Vurderingsportalen */
export interface ForelobigVurdering {
  /** Vurderingsaar (f.eks. 2023 eller 2025) */
  vurderingsaar: number;
  /** Forelobig ejendomsvaerdi i DKK — null for erhverv der ikke faar ejendomsvaerdi */
  ejendomsvaerdi: number | null;
  /** Forelobig grundvaerdi i DKK */
  grundvaerdi: number | null;
  /** Juridisk kategori (f.eks. "Ejerbolig" eller "Erhvervsejendom eller ovrig ejendom") */
  juridiskKategori: string | null;
  /** Ejendomsskat (beregnet af Vurderingsportalen) i DKK — parset fra "X.XXX kr." streng */
  ejendomsskat: number | null;
  /** Grundskyld i DKK — parset fra "X.XXX kr." streng */
  grundskyld: number | null;
  /** Total ejendomsskat (grundskyld + ejendomsværdiskat) i DKK */
  totalSkat: number | null;
}

/** API-svar fra /api/vurdering-forelobig */
export interface ForelobigVurderingResponse {
  /** Array af forelobige vurderinger, sorteret nyeste forst */
  forelobige: ForelobigVurdering[];
  /** Fejlbesked — null hvis alt gik godt */
  fejl: string | null;
}

// ─── Raw Elasticsearch response types ────────────────────────────────────────

/** Skatte-beregning indlejret i hvert Elasticsearch-dokument */
interface RawTaxCalculation {
  propertyTax?: string;
  groundTax?: string;
  totalAddressTax?: string;
}

/** Et enkelt _source dokument fra Vurderingsportalens ES-indeks */
interface RawPreliminaryProperty {
  id: string;
  adresseID?: string;
  adgangsAdresseID?: string;
  vurderingsEjendomID?: number;
  vurderingsaar?: string;
  juridiskKategori?: string;
  propertyValue?: string;
  groundValue?: string;
  groundHousingValue?: string;
  productionGroundValue?: string;
  otherLandGroundValue?: string;
  twoHousingUnits?: boolean;
  address?: string;
  roadName?: string;
  houseNumber?: string;
  door?: string;
  floor?: string;
  townName?: string;
  zipcode?: string;
  postDistrict?: string;
  municipalityNumber?: string;
  propertyNumber?: string;
  isParentProperty?: boolean;
  bfeNumbers?: string;
  taxCalculation?: RawTaxCalculation;
  documentType?: number;
  keNumber?: string;
}

/** Elasticsearch search response wrapper */
interface ESSearchResponse {
  hits?: {
    total?: { value: number };
    hits?: Array<{ _source: RawPreliminaryProperty }>;
  };
}

// ─── Elasticsearch URL ───────────────────────────────────────────────────────

const ES_URL = 'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search';

/**
 * Browser-lignende User-Agent paakraevet for at undgaa 403 Forbidden
 * fra Vurderingsportalens CloudFront/WAF.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parser en DKK-formateret streng som "3.983 kr." til et heltal (3983).
 * Returnerer null hvis strengen ikke kan parses.
 *
 * @param str - Formateret skattestreng fra Vurderingsportalen
 * @returns Belob i DKK som heltal, eller null
 */
function parseDKKString(str: string | undefined | null): number | null {
  if (!str) return null;
  // Fjern "kr.", mellemrum og punktummer (tusindtals-separator)
  const cleaned = str.replace(/kr\.?/gi, '').replace(/\./g, '').replace(/\s/g, '').trim();
  if (!cleaned || cleaned === '0') return 0;
  const val = parseInt(cleaned, 10);
  return isNaN(val) ? null : val;
}

/**
 * Sender en Elasticsearch-soegning til Vurderingsportalen.
 *
 * @param esQuery - Elasticsearch query body (JSON-serialiserbar)
 * @returns Parsed ES search response, eller null ved fejl
 */
async function searchVurderingsportalen(
  esQuery: Record<string, unknown>
): Promise<ESSearchResponse | null> {
  try {
    const res = await fetch(ES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`Vurderingsportalen ES returned ${res.status}`);
      return null;
    }

    return (await res.json()) as ESSearchResponse;
  } catch (err) {
    console.error('Vurderingsportalen ES fetch error:', err);
    return null;
  }
}

/**
 * Mapper raa ES-dokumenter til ForelobigVurdering[].
 * Filtrerer kun isParentProperty=true dokumenter (de med fuld data),
 * og sorterer nyeste vurderingsaar forst.
 *
 * @param hits - Array af ES _source dokumenter
 * @returns Sorteret array af ForelobigVurdering
 */
function mapHitsToForelobige(hits: RawPreliminaryProperty[]): ForelobigVurdering[] {
  return hits
    .filter((h) => h.isParentProperty === true && h.vurderingsaar != null)
    .map((h) => ({
      vurderingsaar: parseInt(h.vurderingsaar!, 10),
      ejendomsvaerdi: h.propertyValue ? parseInt(h.propertyValue, 10) || null : null,
      grundvaerdi: h.groundValue ? parseInt(h.groundValue, 10) || null : null,
      juridiskKategori: h.juridiskKategori ?? null,
      ejendomsskat: parseDKKString(h.taxCalculation?.propertyTax),
      grundskyld: parseDKKString(h.taxCalculation?.groundTax),
      totalSkat: parseDKKString(h.taxCalculation?.totalAddressTax),
    }))
    .sort((a, b) => b.vurderingsaar - a.vurderingsaar);
}

/**
 * Bygger en Elasticsearch bool-filter query for adresse-ID opslag.
 * Soeger paa baade adgangsAdresseID.keyword og adresseID.keyword.
 *
 * @param adresseId - DAWA adgangsadresse- eller adresse-ID (UUID)
 * @returns ES query body
 */
function buildAdresseIdQuery(adresseId: string): Record<string, unknown> {
  return {
    size: 50,
    query: {
      bool: {
        should: [
          { term: { 'adgangsAdresseID.keyword': adresseId } },
          { term: { 'adresseID.keyword': adresseId } },
        ],
        minimum_should_match: 1,
      },
    },
  };
}

/**
 * Bygger en Elasticsearch bool-filter query for kommune/vej/husnr opslag.
 *
 * @param kommunenr - Kommunenummer (f.eks. "101" for Kobenhavn)
 * @param vejnavn - Vejnavn (f.eks. "Vesterbrogade")
 * @param husnr - Husnummer (f.eks. "29")
 * @returns ES query body
 */
function buildAdresseQuery(
  kommunenr: string,
  vejnavn: string,
  husnr: string
): Record<string, unknown> {
  return {
    size: 50,
    query: {
      bool: {
        filter: [
          { term: { municipalityNumber: kommunenr } },
          { term: { 'roadName.keyword': vejnavn } },
          { term: { houseNumber: husnr } },
        ],
      },
    },
  };
}

/**
 * Bygger en Elasticsearch bool-filter query for BFE-nummer opslag.
 *
 * @param bfeNummer - BFE-nummer som streng
 * @returns ES query body
 */
function buildBfeQuery(bfeNummer: string): Record<string, unknown> {
  return {
    size: 50,
    query: {
      bool: {
        filter: [{ term: { bfeNumbers: bfeNummer } }],
      },
    },
  };
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<ForelobigVurderingResponse>> {
  const { searchParams } = request.nextUrl;

  const adresseId = searchParams.get('adresseId');
  const kommunenr = searchParams.get('kommunenr');
  const vejnavn = searchParams.get('vejnavn');
  const husnr = searchParams.get('husnr');
  const bfeNummer = searchParams.get('bfeNummer');

  // Valider at mindst ét soegekriterie er angivet
  const harAdresseId = adresseId && adresseId.length > 10;
  const harAdresseSoeg = kommunenr && vejnavn && husnr;
  const harBfe = bfeNummer && /^\d+$/.test(bfeNummer);

  if (!harAdresseId && !harAdresseSoeg && !harBfe) {
    return NextResponse.json(
      {
        forelobige: [],
        fejl: 'Angiv mindst ét soegekriterie: adresseId, kommunenr+vejnavn+husnr, eller bfeNummer',
      },
      { status: 400 }
    );
  }

  try {
    let esResult: ESSearchResponse | null = null;

    // Strategi 1: Soeg paa adresseId
    if (harAdresseId) {
      esResult = await searchVurderingsportalen(buildAdresseIdQuery(adresseId!));
    }

    // Strategi 2: Soeg paa kommune/vej/husnr
    if (!esResult?.hits?.hits?.length && harAdresseSoeg) {
      esResult = await searchVurderingsportalen(buildAdresseQuery(kommunenr!, vejnavn!, husnr!));
    }

    // Strategi 3: Soeg paa BFE-nummer
    if (!esResult?.hits?.hits?.length && harBfe) {
      esResult = await searchVurderingsportalen(buildBfeQuery(bfeNummer!));
    }

    if (!esResult?.hits?.hits?.length) {
      return NextResponse.json(
        { forelobige: [], fejl: null },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
          },
        }
      );
    }

    const sources = esResult.hits!.hits!.map((h) => h._source);
    const forelobige = mapHitsToForelobige(sources);

    return NextResponse.json(
      { forelobige, fejl: null },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
        },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json(
      { forelobige: [], fejl: `Fejl ved hentning af forelobige vurderinger: ${msg}` },
      { status: 200 }
    );
  }
}
