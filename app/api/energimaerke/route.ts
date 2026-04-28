/**
 * GET /api/energimaerke?bfeNummer=XXXXXX
 *
 * Henter energimærkerapporter for en ejendom via Energistyrelsens EMOData-service.
 *
 * Fremgangsmåde:
 *  1. Forespørger SearchEnergyLabelBFE/{bfeNumber} med HTTP Basic Auth
 *  2. Parser BfeResponse.EnergyLabels til normaliseret liste
 *  3. PDF-download sker via /api/energimaerke/pdf/[id] der proxyer med auth
 *
 * Kilde: https://emoweb.dk/EMOData/EMOData.svc (Energistyrelsen EMOData)
 * Kræver: EMO_USERNAME og EMO_PASSWORD i .env.local
 *
 * @param searchParams.bfeNummer - BFE-nummer for ejendommen
 * @returns JSON med { maerker, manglerAdgang, fejl }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';

/** Zod schema for /api/energimaerke query parameters */
const energimaerkeQuerySchema = z.object({
  bfeNummer: z.string().regex(/^\d+$/),
});

const EMO_BASE = 'https://emoweb.dk/EMOData/EMOData.svc';

// ─── Types ─────────────────────────────────────────────────────────────────

export type EnergiKlasse = 'A2020' | 'A2015' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | string;

export interface EnergimaerkeBygning {
  /** Bygningsnummer */
  bygningsnr: string;
  /** BBR anvendelseskode */
  anvendelseskode: string | null;
  /** Opførelsesår */
  opfoerelsesaar: number | null;
  /** Varmeforsyning */
  varmeforsyning: string | null;
}

export interface EnergimaerkeItem {
  /** Serienummer — bruges til PDF-proxy URL */
  serialId: string;
  /** Energiklasse f.eks. "C" eller "A2020" */
  klasse: EnergiKlasse;
  /** Gyldigt fra dato formateret "1. jan. 2020" */
  gyldigFra: string | null;
  /** Udløbsdato formateret "1. jan. 2030" */
  udloeber: string | null;
  /** Status f.eks. "Gyldig" eller "Ugyldig" */
  status: string | null;
  /** Adressebetegnelse */
  adresse: string | null;
  /** True hvis PDF er tilgængelig */
  harPdf: boolean;
  /** Intern proxy-URL til PDF-download */
  pdfUrl: string;
  /** Bygninger dækket af dette mærke */
  bygninger: EnergimaerkeBygning[];
}

export interface EnergimaerkeResponse {
  maerker: EnergimaerkeItem[] | null;
  /** True hvis EMO_USERNAME/PASSWORD mangler i .env.local */
  manglerAdgang: boolean;
  fejl: string | null;
}

// ─── Raw EMO response types ─────────────────────────────────────────────────

interface EmoBygning {
  BuildingNumber?: unknown;
  BBRUseCode?: unknown;
  YearOfConstruction?: unknown;
  HeatSupply?: unknown;
}

interface EmoEnergyLabel {
  EnergyLabelSerialIdentifier?: unknown;
  EnergyLabelClassification?: unknown;
  ValidFrom?: unknown;
  ValidTo?: unknown;
  LabelStatus?: unknown;
  LabelStatusCode?: unknown;
  StreetName?: unknown;
  HouseNumber?: unknown;
  ZipCode?: unknown;
  CityName?: unknown;
  HasPdf?: unknown;
  Buildings?: EmoBygning[];
}

interface EmoBfeResponse {
  EnergyLabels?: EmoEnergyLabel[] | null;
}

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
 * Formaterer EMO-dato til dansk format "15. okt. 2020".
 * EMO returnerer datoer som "DD-MM-YYYY" (f.eks. "15-10-2020"),
 * ikke ISO-format — derfor håndteres dette format eksplicit.
 *
 * @param val - Rå dato fra EMO API
 * @returns Formateret datostreng eller null
 */
function formatEmoDato(val: unknown): string | null {
  if (!val) return null;
  const str = String(val).trim();

  // Primært format fra EMO: DD-MM-YYYY
  const ddmmyyyy = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyy) {
    const day = parseInt(ddmmyyyy[1], 10);
    const month = parseInt(ddmmyyyy[2], 10);
    const year = ddmmyyyy[3];
    if (!isNaN(day) && month >= 1 && month <= 12) {
      return `${day}. ${DK_MÅNEDER[month - 1]} ${year}`;
    }
  }

  // Fallback: ISO-format YYYY-MM-DD eller ISO-datetime
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return `${d.getDate()}. ${DK_MÅNEDER[d.getMonth()]} ${d.getFullYear()}`;
  }

  return null;
}

/**
 * Bygger HTTP Basic Auth header fra EMO credentials i .env.local.
 *
 * @returns Authorization header-værdi
 */
function basicAuth(): string {
  const u = process.env.EMO_USERNAME ?? '';
  const p = process.env.EMO_PASSWORD ?? '';
  return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EnergimaerkeResponse>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as EnergimaerkeResponse, {
      status: 401,
    });

  // Validate query params with Zod schema
  const parsed = parseQuery(request, energimaerkeQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<EnergimaerkeResponse>;

  const { bfeNummer } = parsed.data;

  /* BIZZ-1096: Cache-first — tjek bbr_ejendom_status.energimaerke_data */
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cached } = (await (admin as any)
      .from('bbr_ejendom_status')
      .select('energimaerke_data')
      .eq('bfe_nummer', Number(bfeNummer))
      .maybeSingle()) as { data: { energimaerke_data: EnergimaerkeItem[] | null } | null };

    if (
      cached?.energimaerke_data &&
      Array.isArray(cached.energimaerke_data) &&
      cached.energimaerke_data.length > 0
    ) {
      return NextResponse.json(
        { maerker: cached.energimaerke_data, manglerAdgang: false, fejl: null },
        { headers: { 'Cache-Control': 'public, s-maxage=86400', 'X-Cache': 'HIT' } }
      );
    }
  } catch {
    /* cache miss — fall through */
  }

  if (!process.env.EMO_USERNAME || !process.env.EMO_PASSWORD) {
    return NextResponse.json({
      maerker: null,
      manglerAdgang: true,
      fejl: 'EMO_USERNAME / EMO_PASSWORD ikke sat i .env.local',
    });
  }

  try {
    const res = await fetch(`${EMO_BASE}/SearchEnergyLabelBFE/${encodeURIComponent(bfeNummer)}`, {
      headers: { Authorization: basicAuth(), Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({
        maerker: null,
        manglerAdgang: true,
        fejl: 'Uautoriseret — tjek EMO_USERNAME/PASSWORD i .env.local',
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(`[Energimærke] HTTP ${res.status} for BFE ${bfeNummer}: ${body.slice(0, 300)}`);
      return NextResponse.json({
        maerker: null,
        manglerAdgang: false,
        fejl: `EMO-service fejl (HTTP ${res.status})`,
      });
    }

    const data = (await res.json()) as EmoBfeResponse;

    if (!data.EnergyLabels?.length) {
      // Ingen energimærker — ikke en fejl, ejendommen er bare ikke mærket
      return NextResponse.json({ maerker: [], manglerAdgang: false, fejl: null });
    }

    const maerker: EnergimaerkeItem[] = data.EnergyLabels.map((label) => {
      const serialId = String(label.EnergyLabelSerialIdentifier ?? '');
      const adresse =
        [label.StreetName, label.HouseNumber, label.ZipCode, label.CityName]
          .filter(Boolean)
          .map(String)
          .join(' ') || null;

      const bygninger: EnergimaerkeBygning[] = (label.Buildings ?? []).map((b) => ({
        bygningsnr: String(b.BuildingNumber ?? ''),
        anvendelseskode: b.BBRUseCode ? String(b.BBRUseCode) : null,
        opfoerelsesaar: b.YearOfConstruction ? Number(b.YearOfConstruction) : null,
        varmeforsyning: b.HeatSupply ? String(b.HeatSupply) : null,
      }));

      // HasPdf kan returneres som boolean true, integer 1 eller string "True"
      const harPdf =
        !!serialId &&
        (label.HasPdf === true ||
          label.HasPdf === 1 ||
          String(label.HasPdf).toLowerCase() === 'true');

      // Oversæt engelsk LabelStatus til dansk
      const statusRaw = label.LabelStatus ? String(label.LabelStatus).toLowerCase() : null;
      const status =
        statusRaw === 'valid'
          ? 'Gyldig'
          : statusRaw === 'invalid' || statusRaw === 'expired'
            ? 'Ugyldig'
            : statusRaw === 'superseded'
              ? 'Erstattet'
              : label.LabelStatus
                ? String(label.LabelStatus)
                : null;

      return {
        serialId,
        klasse: String(label.EnergyLabelClassification ?? ''),
        gyldigFra: formatEmoDato(label.ValidFrom),
        udloeber: formatEmoDato(label.ValidTo),
        status,
        adresse,
        harPdf,
        pdfUrl: serialId ? `/api/energimaerke/pdf/${encodeURIComponent(serialId)}` : '',
        bygninger,
      } satisfies EnergimaerkeItem;
    });

    return NextResponse.json(
      { maerker, manglerAdgang: false, fejl: null },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    logger.error('[Energimærke] Fetch fejl:', err);
    return NextResponse.json({
      maerker: null,
      manglerAdgang: false,
      fejl: 'Timeout eller netværksfejl mod EMO-service',
    });
  }
}
