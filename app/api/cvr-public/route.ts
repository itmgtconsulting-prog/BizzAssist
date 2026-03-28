/**
 * GET /api/cvr-public?vat=XXXXXXXX
 * GET /api/cvr-public?name=Virksomhedsnavn
 *
 * Server-side proxy til cvrapi.dk — gratis offentlig CVR-API.
 * Returnerer udvidet virksomhedsdata inkl. ejere og produktionsenheder.
 * Understøtter både CVR-nummer (vat) og navnesøgning (name).
 *
 * Endpoint: https://cvrapi.dk/api?country=dk&vat=XXXXXXXX
 *           https://cvrapi.dk/api?country=dk&name=Virksomhedsnavn
 * Auth:     Ingen — kræver blot en User-Agent header.
 * Cache:    1 time for vat-opslag, 5 min for navnesøgning.
 *
 * @param vat - 8-cifret dansk CVR-nummer (query param), eller
 * @param name - Virksomhedsnavn at søge efter (query param)
 * @returns CVRPublicData objekt eller { error: string }
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Udvidet virksomhedsdata fra cvrapi.dk */
export interface CVRPublicData {
  /** CVR-nummer */
  vat: number;
  /** Virksomhedsnavn */
  name: string;
  /** Vejadresse */
  address: string;
  /** Postnummer */
  zipcode: string;
  /** By */
  city: string;
  /** Telefonnummer */
  phone: string | null;
  /** Emailadresse */
  email: string | null;
  /** Branchekode (DB07) */
  industrycode: number | null;
  /** Branchebeskrivelse */
  industrydesc: string | null;
  /** Virksomhedsformkode */
  companycode: number | null;
  /** Virksomhedsformbeskrivelse, f.eks. "Enkeltmandsvirksomhed" */
  companydesc: string | null;
  /** Startdato, f.eks. "01/04 - 2015" */
  startdate: string | null;
  /** Slutdato (null hvis stadig aktiv) */
  enddate: string | null;
  /** Antal ansatte (interval-streng) */
  employees: string | null;
  /** c/o-adresse */
  addressco: string | null;
  /** Kreditoplysning startdato */
  creditstartdate: string | null;
  /** Kreditstatus, f.eks. "NORMAL" */
  creditstatus: string | null;
  /** Ejere */
  owners: Array<{ name: string }> | null;
  /** Produktionsenheder (P-numre) */
  productionunits: Array<{
    pno: number;
    main: boolean;
    name: string;
    address: string;
    zipcode: string;
    city: string;
    industrydesc: string | null;
  }> | null;
}

/** Fejl-response shape */
export interface CVRPublicError {
  error: string;
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * Map rå cvrapi.dk response til CVRPublicData.
 *
 * @param raw - Rå JSON fra cvrapi.dk
 * @param fallbackVat - Fallback CVR-nummer (fra query param)
 * @returns Mappet CVRPublicData
 */
function mapRawToCvrData(raw: Record<string, unknown>, fallbackVat: string): CVRPublicData {
  return {
    vat: typeof raw.vat === 'number' ? raw.vat : parseInt(fallbackVat, 10),
    name: String(raw.name ?? ''),
    address: String(raw.address ?? ''),
    zipcode: String(raw.zipcode ?? ''),
    city: String(raw.city ?? ''),
    phone: raw.phone ? String(raw.phone) : null,
    email: raw.email ? String(raw.email) : null,
    industrycode: typeof raw.industrycode === 'number' ? raw.industrycode : null,
    industrydesc: raw.industrydesc ? String(raw.industrydesc) : null,
    companycode: typeof raw.companycode === 'number' ? raw.companycode : null,
    companydesc: raw.companydesc ? String(raw.companydesc) : null,
    startdate: raw.startdate ? String(raw.startdate) : null,
    enddate: raw.enddate ? String(raw.enddate) : null,
    employees: raw.employees != null ? String(raw.employees) : null,
    addressco: raw.addressco ? String(raw.addressco) : null,
    creditstartdate: raw.creditstartdate ? String(raw.creditstartdate) : null,
    creditstatus: raw.creditstatus ? String(raw.creditstatus) : null,
    owners: Array.isArray(raw.owners)
      ? (raw.owners as Array<Record<string, unknown>>).map((o) => ({
          name: String(o.name ?? ''),
        }))
      : null,
    productionunits: Array.isArray(raw.productionunits)
      ? (raw.productionunits as Array<Record<string, unknown>>).map((p) => ({
          pno: typeof p.pno === 'number' ? p.pno : 0,
          main: Boolean(p.main),
          name: String(p.name ?? ''),
          address: String(p.address ?? ''),
          zipcode: String(p.zipcode ?? ''),
          city: String(p.city ?? ''),
          industrydesc: p.industrydesc ? String(p.industrydesc) : null,
        }))
      : null,
  };
}

/**
 * Henter virksomhedsdata fra cvrapi.dk via CVR-nummer eller navn.
 *
 * @param req - Next.js request med ?vat= eller ?name= query param
 * @returns CVRPublicData eller fejlbesked
 */
export async function GET(req: NextRequest): Promise<NextResponse<CVRPublicData | CVRPublicError>> {
  const vat = req.nextUrl.searchParams.get('vat') ?? '';
  const name = req.nextUrl.searchParams.get('name') ?? '';

  // Valider: enten vat (8 cifre) eller name (mindst 2 tegn)
  if (!vat && !name) {
    return NextResponse.json(
      { error: 'Angiv enten ?vat= eller ?name= parameter' },
      { status: 400 }
    );
  }

  if (vat && !/^\d{8}$/.test(vat)) {
    return NextResponse.json({ error: 'Ugyldigt CVR-nummer — skal være 8 cifre' }, { status: 400 });
  }

  if (!vat && name.trim().length < 2) {
    return NextResponse.json({ error: 'Navn skal være mindst 2 tegn' }, { status: 400 });
  }

  // Byg cvrapi.dk URL baseret på søgetype
  const queryParam = vat ? `vat=${vat}` : `name=${encodeURIComponent(name.trim())}`;
  const cacheTime = vat ? 3600 : 300; // 1 time for CVR, 5 min for navnesøgning

  try {
    const res = await fetch(`https://cvrapi.dk/api?country=dk&${queryParam}`, {
      headers: {
        'User-Agent': 'BizzAssist/1.0 (contact@bizzassist.dk)',
      },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: cacheTime },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `CVR-opslag fejlede (HTTP ${res.status})` },
        { status: 502 }
      );
    }

    const raw: Record<string, unknown> = await res.json();

    // cvrapi.dk returnerer { error: true, message: "..." } ved ingen match
    if (raw.error) {
      return NextResponse.json(
        { error: String(raw.message ?? 'Virksomhed ikke fundet') },
        { status: 404 }
      );
    }

    const data = mapRawToCvrData(raw, vat || '0');

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=600`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'CVR-opslag mislykkedes — prøv igen senere' },
      { status: 502 }
    );
  }
}
