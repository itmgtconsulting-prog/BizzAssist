/**
 * GET /api/tinglysning/senesteaendring?bfe=XXXX
 * GET /api/tinglysning/senesteaendring?ejerlav=XXXX&matrikel=XXXX
 *
 * BIZZ-523: Henter tidspunktet for SENESTE ændring af et givent
 * tinglysningsobjekt. Bruges som let-vægt cache-validering før et
 * potentielt tungt /ejdsummarisk-opslag — hvis senestaendringsdato
 * er ældre end vores cached-version, kan vi springe det tunge
 * fetch over.
 *
 * Tinglysning endpoint: POST /tinglysning/ssl/tinglysningsobjekter/senesteaendring
 * Se http_api_beskrivelse v1.12, afsnit 4.8.3.
 *
 * @param bfe      - BestemtFastEjendomNummer (8+ cifre)
 * @param ejerlav  - cadastralDistrictIdentifier (alternativ til bfe)
 * @param matrikel - matrikelnummer (kræver ejerlav)
 *
 * @returns { aendringsDato: ISO 8601 string | null, fejl?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { tlPost } from '@/app/lib/tlFetch';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';
export const maxDuration = 15;

/** Response shape */
export interface SenesteAendringResponse {
  /** ISO 8601 tidsstempel for seneste ændring, null hvis ukendt */
  aendringsDato: string | null;
  /** Fejlbesked hvis API-kald fejlede */
  fejl?: string;
}

const senesteAendringSchema = z
  .object({
    bfe: z.string().regex(/^\d+$/, 'bfe skal være numerisk').optional(),
    ejerlav: z.string().regex(/^\d+$/, 'ejerlav skal være numerisk').optional(),
    matrikel: z.string().min(1).optional(),
  })
  .refine((d) => d.bfe != null || (d.ejerlav != null && d.matrikel != null), {
    message: 'Angiv enten bfe ELLER ejerlav+matrikel',
  });

/**
 * GET /api/tinglysning/senesteaendring
 * Henter seneste-ændringsdato for et tinglysningsobjekt.
 */
export async function GET(req: NextRequest): Promise<NextResponse<SenesteAendringResponse>> {
  const session = await resolveTenantId();
  if (!session) {
    return NextResponse.json({ aendringsDato: null, fejl: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseQuery(req, senesteAendringSchema);
  if (!parsed.success) {
    return NextResponse.json(
      { aendringsDato: null, fejl: 'Angiv enten bfe ELLER ejerlav+matrikel' },
      { status: 400 }
    );
  }
  const { bfe, ejerlav, matrikel } = parsed.data;

  const certConfigured =
    !!(process.env.TINGLYSNING_CERT_PATH || process.env.TINGLYSNING_CERT_B64) &&
    !!process.env.TINGLYSNING_CERT_PASSWORD;
  if (!certConfigured) {
    return NextResponse.json(
      { aendringsDato: null, fejl: 'Tinglysning certifikat ikke konfigureret' },
      { status: 503 }
    );
  }

  // Byg ejendomIdentifikator efter Tinglysning JSON-format
  const ejendomIdentifikator: Record<string, unknown> = bfe
    ? { BestemtFastEjendomNummer: bfe }
    : {
        matrikel: [
          {
            cadastralDistrictIdentifier: Number(ejerlav),
            matrikelnummer: matrikel,
          },
        ],
      };

  try {
    const requestBody = {
      SenesteAendringTinglysningsobjektHentType: { ejendomIdentifikator },
    };
    const res = await tlPost('/tinglysningsobjekter/senesteaendring', requestBody);

    if (res.status === 404) {
      // Tinglysning kender ikke objektet — det er ikke en fejl, blot ingen data
      return NextResponse.json(
        { aendringsDato: null },
        { status: 200, headers: { 'Cache-Control': 'private, max-age=600' } }
      );
    }

    if (res.status !== 200) {
      logger.error('[senesteaendring] Tinglysning HTTP', res.status);
      return NextResponse.json({ aendringsDato: null, fejl: 'Ekstern API fejl' }, { status: 502 });
    }

    const json = JSON.parse(res.body) as {
      SenesteAendringTinglysningsobjektHentResultat?: { AendringsDato?: string };
    };
    const aendringsDato = json?.SenesteAendringTinglysningsobjektHentResultat?.AendringsDato;
    return NextResponse.json(
      { aendringsDato: aendringsDato ?? null },
      {
        status: 200,
        // 5 min cache — aendringer er sjældne men vi vil ikke aggressivt
        // poll'e tinglysning for samme bfe
        headers: { 'Cache-Control': 'private, max-age=300' },
      }
    );
  } catch (err) {
    logger.error('[senesteaendring] Fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ aendringsDato: null, fejl: 'Ekstern API fejl' }, { status: 500 });
  }
}
