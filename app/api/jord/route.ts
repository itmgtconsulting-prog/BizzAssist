/**
 * GET /api/jord
 *
 * Henter jordforureningsstatus for en matrikel fra Danmarks Miljøportals DkJord API.
 * Kræver ingen autentificering — åbne data.
 *
 * Flow:
 *   1. Modtag ejerlavKode + matrikelnr som query-parametre
 *   2. POST til DkJord /api/Parcel med matrikelinformation
 *   3. Returner forureningsstatus og eventuelle kortlægninger
 *
 * @param request - Next.js request med ?ejerlavKode=xxx&matrikelnr=xxx
 * @returns { items, fejl, ingenData }
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Kortlægningsstatus for en matrikel */
export interface JordParcelItem {
  id: string;
  cadastralDistrictIdentifier: number;
  landParcelIdentifier: string;
  /** Rå statuskode fra DkJord (07, 08, 12, 13, 15, 16, 17) */
  pollutionStatusCodeValue: string | null;
  /** Oversat dansk tekst for statuskoden */
  pollutionStatusText: string | null;
  /** Om ejendommen er omfattet af en boligudtalelse */
  housingStatementIndicator: boolean;
  /** Nuanceringsstatusser (F0, F1, F2) */
  pollutionNuanceStatus: string[];
  /** Lokationsnavne tilknyttet kortlægningen */
  locationNames: string[];
  /** Lokationsreferencer (fx "167-02010") */
  locationReferences: string[];
  /** Senest ændret (ISO-dato) */
  modifiedDate: string | null;
  /** Genvurderingsdato (ISO-dato) */
  recalculationDate: string | null;
  regionCode: number | null;
  /** Regionsnavn på dansk */
  regionNavn: string | null;
  municipalityCode: number | null;
  /** Kommunenavn på dansk */
  kommuneNavn: string | null;
}

/** API-svar fra denne route */
export interface JordResponse {
  items: JordParcelItem[];
  fejl: string | null;
  /** True = opslag lykkedes men matriklen har ingen forureningsdata */
  ingenData: boolean;
}

// ─── Konstanter ──────────────────────────────────────────────────────────────

const DKJORD_BASE = 'https://jord-public-api.miljoeportal.dk';

/**
 * Oversætter DkJord's statuskoder til dansk tekst.
 * Koder defineret i DkJord Public API Guideline.
 */
const POLLUTION_STATUS_KODER: Record<string, string> = {
  '07': 'V1 kortlagt',
  '08': 'V2 kortlagt',
  '12': 'Lokaliseret (uafklaret) — oprydning iværksat',
  '13': 'V1 og V2 kortlagt',
  '15': 'Lokaliseret (uafklaret)',
  '16': 'Udgået inden kortlægning',
  '17': 'Udgået efter kortlægning',
};

/** Oversætter DkJord regionkoder til danske navne */
const REGION_NAVNE: Record<number, string> = {
  1081: 'Region Nordjylland',
  1082: 'Region Midtjylland',
  1083: 'Region Syddanmark',
  1084: 'Region Hovedstaden',
  1085: 'Region Sjælland',
};

/** Oversætter DkJord nuanceringsstatusser til dansk */
const NUANCE_TEKST: Record<string, string> = {
  '': 'Ikke oplyst',
  '00': 'Ikke oplyst',
  '01': 'F0 Nuanceret',
  '02': 'F1 Nuanceret',
  '03': 'F2 Nuanceret',
  F0: 'F0 Nuanceret',
  F1: 'F1 Nuanceret',
  F2: 'F2 Nuanceret',
};

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<JordResponse>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<JordResponse>;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json(
      { items: [], fejl: 'Unauthorized', ingenData: false },
      { status: 401 }
    );
  }

  const { searchParams } = request.nextUrl;
  const ejerlavKodeStr = searchParams.get('ejerlavKode');
  const matrikelnr = searchParams.get('matrikelnr');

  if (!ejerlavKodeStr || !matrikelnr) {
    return NextResponse.json(
      { items: [], fejl: 'Mangler ejerlavKode eller matrikelnr', ingenData: false },
      { status: 400 }
    );
  }

  const ejerlavKode = parseInt(ejerlavKodeStr, 10);
  if (isNaN(ejerlavKode)) {
    return NextResponse.json(
      { items: [], fejl: 'Ugyldigt ejerlavKode — skal være et heltal', ingenData: false },
      { status: 400 }
    );
  }

  try {
    // DkJord public API bruger GET med query-parametre (ikke POST med body)
    const params = new URLSearchParams({
      CadastralDistrictIdentifier: String(ejerlavKode),
      LandParcelIdentifier: matrikelnr,
      Take: '100',
    });
    const res = await fetch(`${DKJORD_BASE}/api/Parcel?${params}`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
      next: { revalidate: 86400 }, // 24 timer — forureningsdata ændres sjældent
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[jord] DkJord HTTP ${res.status}: ${txt.slice(0, 400)}`);
      return NextResponse.json(
        {
          items: [],
          fejl: 'Ekstern API fejl',
          ingenData: false,
        },
        { status: 200 }
      );
    }

    const json = (await res.json()) as {
      items?: Array<{
        id: string;
        cadastralDistrictIdentifier: number;
        landParcelIdentifier: string;
        pollutionStatusCodeValue?: string;
        housingStatementIndicator?: boolean;
        pollutionNuanceStatus?: string[];
        locations?: Array<{ locationReference?: string; locationName?: string }>;
        modifiedDate?: string;
        recalculationDate?: string;
        regionCode?: number;
        municipalityCode?: number;
      }>;
      total?: number;
    };

    if (!json.items?.length) {
      return NextResponse.json({ items: [], fejl: null, ingenData: true }, { status: 200 });
    }

    const items: JordParcelItem[] = json.items.map((item) => ({
      id: item.id,
      cadastralDistrictIdentifier: item.cadastralDistrictIdentifier,
      landParcelIdentifier: item.landParcelIdentifier,
      pollutionStatusCodeValue: item.pollutionStatusCodeValue ?? null,
      pollutionStatusText: item.pollutionStatusCodeValue
        ? (POLLUTION_STATUS_KODER[item.pollutionStatusCodeValue] ?? item.pollutionStatusCodeValue)
        : null,
      housingStatementIndicator: item.housingStatementIndicator ?? false,
      pollutionNuanceStatus: (item.pollutionNuanceStatus ?? [])
        .map((n) => NUANCE_TEKST[n] ?? n)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
      locationNames: (item.locations ?? [])
        .map((l) => l.locationName)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
      locationReferences: (item.locations ?? [])
        .map((l) => l.locationReference)
        .filter((r): r is string => typeof r === 'string' && r.length > 0),
      modifiedDate: item.modifiedDate ?? null,
      recalculationDate: item.recalculationDate ?? null,
      regionCode: item.regionCode ?? null,
      regionNavn: item.regionCode ? (REGION_NAVNE[item.regionCode] ?? null) : null,
      municipalityCode: item.municipalityCode ?? null,
      kommuneNavn: null, // kommunenavn hentes via DAWA hvis nødvendigt
    }));

    return NextResponse.json(
      { items, fejl: null, ingenData: false },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    console.error('[jord] Fejl ved DkJord-opslag:', err);
    return NextResponse.json(
      { items: [], fejl: 'Ekstern API fejl', ingenData: false },
      { status: 200 }
    );
  }
}
