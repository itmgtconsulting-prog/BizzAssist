/**
 * GET /api/tinglysning/aendringer?bog=EJENDOM&datoFra=YYYY-MM-DD&datoTil=YYYY-MM-DD&fraSide=1
 *
 * BIZZ-524: Henter listen af tinglysningsobjekter der er ændret i et givet
 * tidsinterval. Bruges som backbone for "følg ejendom"-notifikationer:
 * cron-jobs kan kalde dette dagligt og krydse resultatet mod fulgte BFE'er
 * for at oprette notifikationer ved ændringer.
 *
 * Tinglysning endpoint: POST /tinglysning/ssl/tinglysningsobjekter/aendringer
 * Se http_api_beskrivelse v1.12, afsnit 4.8.2.
 *
 * @param bog      - "EJENDOM" | "BIL" | "ANDEL" | "PERSON" (default: EJENDOM)
 * @param datoFra  - ISO-dato YYYY-MM-DD
 * @param datoTil  - ISO-dato YYYY-MM-DD
 * @param fraSide  - paging (default: 1)
 *
 * @returns { items: AendretObjekt[], flereResultater: boolean, fraNummer, tilNummer }
 *
 * Retention: ingen — denne route henter kun fra ekstern API og returnerer.
 * Persistente notifikationer dannes af cron (separat) og lagres i tenant.notifications.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { tlPost } from '@/app/lib/tlFetch';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';
export const maxDuration = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Ét ændret tinglysningsobjekt fra Tinglysning API */
export interface AendretObjekt {
  /** BFE-nummer (samlet fast ejendom) — hovedidentifier til at koble mod fulgte ejendomme */
  bfeNummer: string | null;
  /** Ejerlejlighedsnummer hvis det er en ejerlejlighed (null for hovedejendom) */
  ejerlejlighedsnummer: string | null;
  /** Matrikelnummer — fallback identifier */
  matrikelnummer: string | null;
  /** Cadastral district name — fallback identifier (læsbart) */
  ejerlavNavn: string | null;
  /** Tidspunkt for ændringen (ISO 8601 med tidszone) */
  aendringsDato: string;
}

/** Response shape */
export interface AendringerResponse {
  /** Ændrede objekter i intervallet */
  items: AendretObjekt[];
  /** Om der er flere sider af resultater (paging) */
  flereResultater: boolean;
  /** Nummer på første resultat (1-indekseret) */
  fraNummer: number | null;
  /** Nummer på sidste resultat */
  tilNummer: number | null;
  /** Fejlbesked hvis API-kald fejlede */
  fejl?: string;
}

// ─── Query schema ───────────────────────────────────────────────────────────

const aendringerSchema = z.object({
  bog: z.enum(['EJENDOM', 'BIL', 'ANDEL', 'PERSON']).optional().default('EJENDOM'),
  datoFra: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'datoFra skal være YYYY-MM-DD'),
  datoTil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'datoTil skal være YYYY-MM-DD'),
  fraSide: z.coerce.number().int().positive().optional().default(1),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

type ChangeJsonObject = {
  EjendomIdentifikator?: {
    BestemtFastEjendomNummer?: string | number;
    EjendomType?: { Ejerlejlighed?: { Ejerlejlighedsnummer?: string | number } };
    Matrikel?: Array<{ CadastralDistrictName?: string; Matrikelnummer?: string | number }>;
  };
  AendringsDato?: string;
};

/**
 * Mapper et råt JSON-objekt fra Tinglysning til vores AendretObjekt-shape.
 * Returnerer null hvis hverken AendringsDato eller en identifier findes.
 */
function mapAendring(raw: ChangeJsonObject): AendretObjekt | null {
  const dato = raw?.AendringsDato;
  if (!dato) return null;
  const ident = raw?.EjendomIdentifikator;
  const bfe = ident?.BestemtFastEjendomNummer;
  const ejerlejl = ident?.EjendomType?.Ejerlejlighed?.Ejerlejlighedsnummer;
  const matr = ident?.Matrikel?.[0];
  // Mindst ét identificer-felt skal findes for at posten er meningsfuld
  if (!bfe && !ejerlejl && !matr?.Matrikelnummer) return null;
  return {
    bfeNummer: bfe != null ? String(bfe) : null,
    ejerlejlighedsnummer: ejerlejl != null ? String(ejerlejl) : null,
    matrikelnummer: matr?.Matrikelnummer != null ? String(matr.Matrikelnummer) : null,
    ejerlavNavn: matr?.CadastralDistrictName ?? null,
    aendringsDato: dato,
  };
}

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * GET /api/tinglysning/aendringer
 * Henter listen af ændrede tinglysningsobjekter i et tidsinterval.
 */
export async function GET(req: NextRequest): Promise<NextResponse<AendringerResponse>> {
  const session = await resolveTenantId();
  if (!session) {
    return NextResponse.json(
      { items: [], flereResultater: false, fraNummer: null, tilNummer: null, fejl: 'Unauthorized' },
      { status: 401 }
    );
  }

  const parsed = parseQuery(req, aendringerSchema);
  if (!parsed.success) {
    return NextResponse.json(
      {
        items: [],
        flereResultater: false,
        fraNummer: null,
        tilNummer: null,
        fejl: 'Ugyldige parametre — datoFra og datoTil skal være YYYY-MM-DD',
      },
      { status: 400 }
    );
  }
  const { bog, datoFra, datoTil, fraSide } = parsed.data;

  // Cert-sanity check
  const certConfigured =
    !!(process.env.TINGLYSNING_CERT_PATH || process.env.TINGLYSNING_CERT_B64) &&
    !!process.env.TINGLYSNING_CERT_PASSWORD;
  if (!certConfigured) {
    return NextResponse.json(
      {
        items: [],
        flereResultater: false,
        fraNummer: null,
        tilNummer: null,
        fejl: 'Tinglysning certifikat ikke konfigureret',
      },
      { status: 503 }
    );
  }

  try {
    const requestBody = {
      AendredeTinglysningsobjekterHentType: {
        bog,
        datoFra,
        datoTil,
        fraSide,
      },
    };
    const res = await tlPost('/tinglysningsobjekter/aendringer', requestBody);

    if (res.status !== 200) {
      logger.error('[aendringer] Tinglysning HTTP', res.status);
      return NextResponse.json(
        {
          items: [],
          flereResultater: false,
          fraNummer: null,
          tilNummer: null,
          fejl: 'Ekstern API fejl',
        },
        { status: 502 }
      );
    }

    const json = JSON.parse(res.body) as {
      AendredeTinglysningsobjekterHentResultat?: {
        AendretTinglysningsobjektSamling?: ChangeJsonObject[];
        SoegningResultatInterval?: {
          FraNummer?: string | number;
          TilNummer?: string | number;
          FlereResultater?: boolean;
        };
      };
    };
    const result = json.AendredeTinglysningsobjekterHentResultat;
    const rawItems = result?.AendretTinglysningsobjektSamling ?? [];
    const items = rawItems.map(mapAendring).filter((x): x is AendretObjekt => x !== null);
    const interval = result?.SoegningResultatInterval;

    return NextResponse.json(
      {
        items,
        flereResultater: interval?.FlereResultater ?? false,
        fraNummer: interval?.FraNummer != null ? Number(interval.FraNummer) : null,
        tilNummer: interval?.TilNummer != null ? Number(interval.TilNummer) : null,
      },
      {
        status: 200,
        // Korte cache — aendringer-feed opdateres løbende
        headers: { 'Cache-Control': 'private, max-age=300' },
      }
    );
  } catch (err) {
    logger.error('[aendringer] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        items: [],
        flereResultater: false,
        fraNummer: null,
        tilNummer: null,
        fejl: 'Ekstern API fejl',
      },
      { status: 500 }
    );
  }
}
