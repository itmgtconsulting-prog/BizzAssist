/**
 * GET /api/plandata?adresseId=UUID
 *
 * Henter lokalplaner, delområder og kommuneplanrammer for en adresse
 * via plandata.dk's GeoServer WFS — gratis, ingen API-nøgle krævet.
 *
 * Fremgangsmåde:
 *  1. Henter WGS84-koordinater fra DAWA (prøver /adresser og /adgangsadresser)
 *  2. Forespørger plandata.dk GeoServer med INTERSECTS CQL-filter på 9 lag parallelt
 *     OBS: SRID=4326; præfiks er påkrævet i filtret — uden det tolker GeoServer
 *     koordinaterne som EPSG:25832 (UTM32N) og returnerer 0 resultater.
 *  3. Returnerer normaliseret liste sorteret nyeste år først
 *
 * Kilde: https://geoserver.plandata.dk/geoserver/wfs (SDFI / Plandata.dk)
 *
 * @param searchParams.adresseId - DAWA adresse- eller adgangsadresse-UUID
 * @returns JSON med { planer, fejl }
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

const PLANDATA_WFS = 'https://geoserver.plandata.dk/geoserver/wfs';
const DAWA_BASE = 'https://api.dataforsyningen.dk';

// ─── Types ─────────────────────────────────────────────────────────────────

export type PlanStatus = 'Vedtaget' | 'Forslag' | 'Aflyst';
export type PlanType = 'Lokalplan' | 'Delområde' | 'Kommuneplan';

/** Detaljefelter der vises i den ekspanderede plan-række */
export interface PlandataDetaljer {
  /** Generel anvendelse (f.eks. "Erhvervsområde") */
  anvendelse: string | null;
  /** Delområdenummer (kun for delomraader, f.eks. "C") */
  delnr: string | null;
  /** Maks. tilladte bebyggelsesprocent */
  bebygpct: number | null;
  /** Maks. tilladte antal etager */
  maxetager: number | null;
  /** Maks. tilladte bygningshøjde i meter */
  maxbygnhjd: number | null;
  /** Min. grundstørrelse ved udstykning i m² */
  minuds: number | null;
  /** Forslagsdato formateret som "25. mar. 2014" */
  datoforsl: string | null;
  /** Vedtagelsesdato formateret */
  datovedt: string | null;
  /** Dato trådt i kraft formateret */
  datoikraft: string | null;
  /** Startdato formateret */
  datostart: string | null;
  /** Slutdato formateret */
  datoslut: string | null;
}

export interface PlandataItem {
  /** Intern plan-UUID eller planid */
  id: string;
  /** Plantype til visning */
  type: PlanType;
  /** Plannummer f.eks. "232" eller "2A2" */
  nummer: string;
  /** Planens navn */
  navn: string;
  /** Vedtaget / Forslag / Aflyst */
  status: PlanStatus;
  /** Årstal — for forslag bruges forslagsdato, for vedtaget/aflyst vedtagelsesdato */
  aar: number | null;
  /** Kommunenavn */
  kommunenavn: string | null;
  /** Link til plan-PDF */
  doklink: string | null;
  /** Detaljefelter til ekspanderet visning */
  detaljer: PlandataDetaljer;
}

export interface PlandataResponse {
  planer: PlandataItem[] | null;
  fejl: string | null;
}

// ─── WFS layer config ───────────────────────────────────────────────────────

interface LayerConfig {
  typeName: string;
  planType: PlanType;
  planStatus: PlanStatus;
}

/**
 * Alle plandata-lag der forespørges parallelt.
 * Status er kodet ind i typenavnet for at undgå at hente alle lag og filtrere.
 */
const LAYERS: LayerConfig[] = [
  { typeName: 'pdk:theme_pdk_lokalplan_vedtaget', planType: 'Lokalplan', planStatus: 'Vedtaget' },
  { typeName: 'pdk:theme_pdk_lokalplan_forslag', planType: 'Lokalplan', planStatus: 'Forslag' },
  { typeName: 'pdk:theme_pdk_lokalplan_aflyst', planType: 'Lokalplan', planStatus: 'Aflyst' },
  {
    typeName: 'pdk:theme_pdk_lokalplandelomraade_vedtaget',
    planType: 'Delområde',
    planStatus: 'Vedtaget',
  },
  {
    typeName: 'pdk:theme_pdk_lokalplandelomraade_forslag',
    planType: 'Delområde',
    planStatus: 'Forslag',
  },
  {
    typeName: 'pdk:theme_pdk_lokalplandelomraade_aflyst',
    planType: 'Delområde',
    planStatus: 'Aflyst',
  },
  {
    typeName: 'pdk:theme_pdk_kommuneplanramme_vedtaget_v',
    planType: 'Kommuneplan',
    planStatus: 'Vedtaget',
  },
  {
    typeName: 'pdk:theme_pdk_kommuneplanramme_forslag_v',
    planType: 'Kommuneplan',
    planStatus: 'Forslag',
  },
  {
    typeName: 'pdk:theme_pdk_kommuneplanramme_aflyst_v',
    planType: 'Kommuneplan',
    planStatus: 'Aflyst',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const DK_MÅNEDER = [
  'jan.',
  'feb.',
  'mar.',
  'apr.',
  'maj',
  'jun.',
  'jul.',
  'aug.',
  'sep.',
  'okt.',
  'nov.',
  'dec.',
];

/**
 * Formaterer et YYYYMMDD-heltal til dansk datostreng, f.eks. "26. aug. 2014".
 *
 * @param val - Rå dato-felt fra GeoServer (integer eller string, f.eks. 20140826)
 * @returns Formateret datostreng, eller null
 */
function formatDato(val: unknown): string | null {
  if (val == null) return null;
  const str = String(val).trim();
  if (str.length < 8) return null;
  const year = str.slice(0, 4);
  const month = parseInt(str.slice(4, 6), 10);
  const day = parseInt(str.slice(6, 8), 10);
  if (isNaN(month) || isNaN(day) || month < 1 || month > 12) return null;
  return `${day}. ${DK_MÅNEDER[month - 1]} ${year}`;
}

/**
 * Udtrækker årstal fra dato-felter afhængigt af planstatus.
 * Forslag-planer bruger forslagsdato — vedtaget/aflyst bruger vedtagelsesdato.
 *
 * @param p - WFS properties
 * @param planStatus - Planstatus
 * @returns Årstal eller null
 */
function extractAar(p: WFSProperties, planStatus: PlanStatus): number | null {
  const primary =
    planStatus === 'Forslag'
      ? (p.datoforsl ?? p.datovedt ?? p.datoikraft)
      : (p.datovedt ?? p.datoforsl ?? p.datoikraft);

  if (primary == null) return null;
  const year = parseInt(String(primary).slice(0, 4), 10);
  return isNaN(year) ? null : year;
}

/** Konverterer en WFS-property til number eller null */
function toNum(val: unknown): number | null {
  if (val == null) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

interface WFSProperties {
  planid?: unknown;
  id?: unknown;
  plannr?: unknown;
  plannavn?: unknown;
  status?: unknown;
  planstatus?: unknown;
  datovedt?: unknown;
  datoforsl?: unknown;
  datoikraft?: unknown;
  datostart?: unknown;
  datoslut?: unknown;
  komnr?: unknown;
  kommunenavn?: unknown;
  doklink?: unknown;
  // Delområde-specifikke
  lp_plannr?: unknown;
  lp_plannavn?: unknown;
  delnr?: unknown;
  // Detaljefelter
  anvendelsegenerel?: unknown;
  bebygpct?: unknown;
  maxetager?: unknown;
  maxbygnhjd?: unknown;
  minuds?: unknown;
  mingrund?: unknown;
}

interface WFSFeature {
  properties: WFSProperties | null;
}

interface WFSResponse {
  features?: WFSFeature[];
}

// ─── WFS fetch ──────────────────────────────────────────────────────────────

/**
 * Henter plan-features fra et enkelt plandata.dk GeoServer WFS-lag.
 * Bruger INTERSECTS CQL-filter med SRID=4326 præfiks (påkrævet for WGS84).
 * Returnerer tom liste stille ved fejl.
 *
 * @param x - Longitude (WGS84)
 * @param y - Latitude (WGS84)
 * @param layer - Lag-konfiguration
 */
async function fetchLag(x: number, y: number, layer: LayerConfig): Promise<PlandataItem[]> {
  // SRID=4326; påkrævet — GeoServer native CRS er EPSG:25832
  const cql = encodeURIComponent(`INTERSECTS(geometri,SRID=4326;POINT(${x} ${y}))`);
  const url =
    `${PLANDATA_WFS}?service=WFS&version=1.0.0&request=GetFeature` +
    `&typeName=${encodeURIComponent(layer.typeName)}` +
    `&outputFormat=application/json` +
    `&CQL_FILTER=${cql}` +
    `&maxFeatures=50`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      next: { revalidate: 86400 },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`[Plandata] HTTP ${res.status} for ${layer.typeName}: ${body.slice(0, 300)}`);
      return [];
    }

    const json = (await res.json()) as WFSResponse;
    if (!json.features?.length) return [];

    return json.features
      .map((f, i) => {
        const p = f.properties ?? {};

        // Delområder bruger lp_plannr / lp_plannavn (parent lokalplan)
        const nummer =
          layer.planType === 'Delområde'
            ? String(p.lp_plannr ?? p.plannr ?? '')
            : String(p.plannr ?? '');

        const navn =
          layer.planType === 'Delområde'
            ? String(p.lp_plannavn ?? p.plannavn ?? '')
            : String(p.plannavn ?? '');

        const detaljer: PlandataDetaljer = {
          anvendelse: p.anvendelsegenerel ? String(p.anvendelsegenerel) : null,
          delnr: layer.planType === 'Delområde' && p.delnr ? String(p.delnr) : null,
          bebygpct: toNum(p.bebygpct),
          maxetager: toNum(p.maxetager),
          maxbygnhjd: toNum(p.maxbygnhjd),
          minuds: toNum(p.minuds ?? p.mingrund),
          datoforsl: formatDato(p.datoforsl),
          datovedt: formatDato(p.datovedt),
          datoikraft: formatDato(p.datoikraft),
          datostart: formatDato(p.datostart),
          datoslut: formatDato(p.datoslut),
        };

        return {
          id: String(p.planid ?? p.id ?? `${layer.typeName}-${i}`),
          type: layer.planType,
          nummer,
          navn,
          status: layer.planStatus,
          aar: extractAar(p, layer.planStatus),
          kommunenavn: p.kommunenavn ? String(p.kommunenavn) : null,
          doklink: p.doklink ? String(p.doklink) : null,
          detaljer,
        } satisfies PlandataItem;
      })
      .filter((item) => item.nummer !== '');
  } catch (err) {
    logger.error(`[Plandata] Fejl for ${layer.typeName}:`, err);
    return [];
  }
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<PlandataResponse>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<PlandataResponse>;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ planer: null, fejl: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const adresseId = searchParams.get('adresseId');

  if (!adresseId) {
    return NextResponse.json({ planer: null, fejl: 'Mangler adresseId parameter' });
  }

  // Validate UUID format to prevent path traversal / SSRF via DAWA URL construction
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(adresseId)) {
    return NextResponse.json({ planer: null, fejl: 'Ugyldigt adresseId format' }, { status: 400 });
  }

  try {
    // ── Hent koordinater fra DAWA ──────────────────────────────────────────
    // ID kan være adresse-UUID eller adgangsadresse-UUID — prøv begge endpoints.
    let x: number, y: number;
    try {
      const tryUrls = [
        `${DAWA_BASE}/adresser/${adresseId}?struktur=mini`,
        `${DAWA_BASE}/adgangsadresser/${adresseId}?struktur=mini`,
      ];

      let coords: { x?: number; y?: number } | null = null;
      for (const url of tryUrls) {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const data = (await res.json()) as { x?: number; y?: number };
          if (data.x && data.y) {
            coords = data;
            break;
          }
        }
      }

      if (!coords) {
        return NextResponse.json({ planer: null, fejl: 'Ingen koordinater fundet på adresse' });
      }
      x = coords.x!;
      y = coords.y!;
    } catch (err) {
      logger.error('[Plandata] DAWA fejl:', err);
      return NextResponse.json({ planer: null, fejl: 'Ekstern API fejl' });
    }

    // ── Hent alle plantyper parallelt ─────────────────────────────────────
    const resultater = await Promise.all(LAYERS.map((layer) => fetchLag(x, y, layer)));

    // Dedupliker på type+id
    const seenIds = new Set<string>();
    const planer = resultater
      .flat()
      .filter((item) => {
        const key = `${item.type}-${item.id}`;
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      })
      .sort((a, b) => (b.aar ?? 0) - (a.aar ?? 0));

    return NextResponse.json(
      { planer, fejl: null },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    logger.error('[Plandata] Uventet fejl:', err);
    return NextResponse.json({ planer: null, fejl: 'Ekstern API fejl' }, { status: 200 });
  }
}
