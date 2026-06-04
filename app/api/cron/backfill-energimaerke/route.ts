/**
 * GET /api/cron/backfill-energimaerke
 *
 * BIZZ-2006: Backfiller energimaerke_data i bbr_ejendom_status for rækker
 * hvor feltet er NULL. Kalder EMO SearchEnergyLabelBFE for hver BFE med
 * 2s throttle for ikke at overbelaste Energistyrelsens service.
 *
 * Cap: 50 BFE per kørsel (~100s runtime inkl. throttle).
 * Idempotent: springer over rækker der allerede har data.
 *
 * Schedule: 7 * * * * (hvert time ved :07)
 * Auth: CRON_SECRET bearer + x-vercel-cron header i prod
 *
 * @module api/cron/backfill-energimaerke
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';

export const maxDuration = 300;

/** Max BFE per cron-kørsel */
const BATCH_SIZE = 50;

/** Delay mellem EMO-kald (ms) — 1 req/2s for at skåne EMO */
const THROTTLE_MS = 2000;

/** EMO timeout — 30s som i BIZZ-2004 */
const EMO_TIMEOUT_MS = 30_000;

const EMO_BASE = 'https://emoweb.dk/EMOData/EMOData.svc';

// ─── Raw EMO response types (mirrored from /api/energimaerke) ──────────────

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
 * Formaterer EMO-dato (DD-MM-YYYY) til dansk format.
 *
 * @param val - Rå dato fra EMO API
 * @returns Formateret datostreng eller null
 */
function formatEmoDato(val: unknown): string | null {
  if (!val) return null;
  const str = String(val).trim();
  const ddmmyyyy = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyy) {
    const day = parseInt(ddmmyyyy[1], 10);
    const month = parseInt(ddmmyyyy[2], 10);
    const year = ddmmyyyy[3];
    if (!isNaN(day) && month >= 1 && month <= 12) {
      return `${day}. ${DK_MÅNEDER[month - 1]} ${year}`;
    }
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return `${d.getDate()}. ${DK_MÅNEDER[d.getMonth()]} ${d.getFullYear()}`;
  }
  return null;
}

/**
 * Bygger HTTP Basic Auth header fra EMO credentials.
 *
 * @returns Authorization header-værdi
 */
function basicAuth(): string {
  const u = process.env.EMO_USERNAME ?? '';
  const p = process.env.EMO_PASSWORD ?? '';
  return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
}

/**
 * Verify CRON_SECRET bearer + x-vercel-cron in production.
 *
 * @param request - Incoming request
 * @returns true if authorised
 */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * Henter energimærker for en BFE fra EMO og returnerer normaliseret array.
 * Returnerer tom array ([]) hvis ejendommen ikke har energimærker.
 * Returnerer null ved fejl (timeout, netværk, etc.).
 *
 * @param bfe - BFE-nummer
 * @returns Normaliseret maerker-array eller null ved fejl
 */
async function fetchEmoForBfe(bfe: number): Promise<Record<string, unknown>[] | null> {
  try {
    const res = await fetch(`${EMO_BASE}/SearchEnergyLabelBFE/${bfe}`, {
      headers: { Authorization: basicAuth(), Accept: 'application/json' },
      signal: AbortSignal.timeout(EMO_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!res.ok) {
      logger.error(`[backfill-emo] HTTP ${res.status} for BFE ${bfe}`);
      return null;
    }

    const data = (await res.json()) as EmoBfeResponse;

    if (!data.EnergyLabels?.length) return [];

    return data.EnergyLabels.map((label) => {
      const serialId = String(label.EnergyLabelSerialIdentifier ?? '');
      const adresse =
        [label.StreetName, label.HouseNumber, label.ZipCode, label.CityName]
          .filter(Boolean)
          .map(String)
          .join(' ') || null;

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

      const harPdf =
        !!serialId &&
        (label.HasPdf === true ||
          label.HasPdf === 1 ||
          String(label.HasPdf).toLowerCase() === 'true');

      return {
        serialId,
        klasse: String(label.EnergyLabelClassification ?? ''),
        gyldigFra: formatEmoDato(label.ValidFrom),
        udloeber: formatEmoDato(label.ValidTo),
        status,
        adresse,
        harPdf,
        pdfUrl: serialId ? `/api/energimaerke/pdf/${encodeURIComponent(serialId)}` : '',
        bygninger: (label.Buildings ?? []).map((b) => ({
          bygningsnr: String(b.BuildingNumber ?? ''),
          anvendelseskode: b.BBRUseCode ? String(b.BBRUseCode) : null,
          opfoerelsesaar: b.YearOfConstruction ? Number(b.YearOfConstruction) : null,
          varmeforsyning: b.HeatSupply ? String(b.HeatSupply) : null,
        })),
      };
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const errorType =
      e.name === 'TimeoutError' || e.name === 'AbortError'
        ? 'timeout'
        : e.cause?.code === 'ECONNREFUSED'
          ? 'connection_refused'
          : e.cause?.code === 'ENOTFOUND'
            ? 'dns_failure'
            : 'unknown';

    logger.error(`[backfill-emo] ${errorType} for BFE ${bfe}:`, e.message);
    return null;
  }
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'backfill-energimaerke', schedule: '7 * * * *', intervalMinutes: 60 },
    async () => {
      if (!process.env.EMO_USERNAME || !process.env.EMO_PASSWORD) {
        return NextResponse.json({ error: 'EMO credentials not configured' }, { status: 500 });
      }

      const admin = createAdminClient();

      /* Hent BFE-numre hvor energimaerke_data er NULL */
      const { data: rows, error: qErr } = (await admin
        .from('bbr_ejendom_status')
        .select('bfe_nummer')
        .is('energimaerke_data', null)
        .limit(BATCH_SIZE)) as {
        data: { bfe_nummer: number }[] | null;
        error: { message: string } | null;
      };

      if (qErr) {
        logger.error('[backfill-emo] Query error:', qErr.message);
        return NextResponse.json({ error: 'DB query failed' }, { status: 500 });
      }

      if (!rows?.length) {
        logger.log('[backfill-emo] Ingen NULL-rows — backfill komplet');
        return NextResponse.json({ message: 'Backfill complete', processed: 0, remaining: 0 });
      }

      let updated = 0;
      let failed = 0;
      let empty = 0;

      for (const row of rows) {
        const bfe = row.bfe_nummer as number;
        const maerker = await fetchEmoForBfe(bfe);

        if (maerker === null) {
          /* Fejl — skip denne BFE, prøves igen næste kørsel */
          failed++;
        } else {
          /* Gem resultat (kan være tom array for ejd. uden energimærke) */
          const { error: uErr } = await (
            admin.from('bbr_ejendom_status') as ReturnType<typeof admin.from>
          )
            .update({ energimaerke_data: maerker } as Record<string, unknown>)
            .eq('bfe_nummer', bfe);

          if (uErr) {
            logger.error(`[backfill-emo] Update fejl BFE ${bfe}:`, uErr.message);
            failed++;
          } else {
            updated++;
            if (maerker.length === 0) empty++;
          }
        }

        /* Throttle: 2s mellem requests */
        if (row !== rows[rows.length - 1]) {
          await new Promise((r) => setTimeout(r, THROTTLE_MS));
        }
      }

      /* Check remaining */
      const { count } = await admin
        .from('bbr_ejendom_status')
        .select('bfe_nummer', { count: 'exact', head: true })
        .is('energimaerke_data', null);

      const result = {
        processed: rows.length,
        updated,
        empty,
        failed,
        remaining: count ?? 'unknown',
      };

      logger.log('[backfill-emo] Batch done:', result);

      Sentry.addBreadcrumb({
        category: 'cron',
        message: `backfill-energimaerke: ${updated} updated, ${failed} failed, ${count ?? '?'} remaining`,
        level: 'info',
      });

      return NextResponse.json(result);
    }
  );
}
