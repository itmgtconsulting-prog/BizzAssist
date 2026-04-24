/**
 * BIZZ-826 iter 2d — løbende sync af bbr_ejendom_status.
 *
 * Ugentlig cron der genopfrisker stale rows i bbr_ejendom_status så
 * backfilled data ikke driver fra BBR's live-state over tid.
 *
 * Strategi (Option A fra ticket): Cap 5000 rows pr run der ikke er
 * tjekket de sidste 7 dage. Paginér derigennem over 7 søndage → komplet
 * dækning ~hver 2. måned givet typisk ~46k ejendomme.
 *
 * BBR-query patterneret identisk med scripts/backfill-bbr-status.mjs
 * (BIZZ-824): BBR_Grund.bestemtFastEjendomBFENr → BBR_Bygning join,
 * konsolidér is_udfaset = alle bygninger har retired-status {4,10,11}.
 *
 * Schedule: søndag 02:00 UTC = '0 2 * * 0' i vercel.json.
 *
 * Security: CRON_SECRET bearer + x-vercel-cron=1 i produktion.
 *
 * @module api/cron/refresh-ejendom-status
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { BBR_STATUS_UDFASET } from '@/app/lib/bbrKoder';

const BATCH_SIZE = 50; // BFE'er pr BBR-kald
const PER_RUN_CAP = 5000; // max rows pr cron-tur
const STALE_DAYS = 7;

/**
 * Verificerer CRON_SECRET bearer + x-vercel-cron (i produktion).
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

interface BbrStatusResult {
  is_udfaset: boolean;
  bbr_status_code: number | null;
  adgangsadresse_id: string | null;
  kommune_kode: number | null;
}

/**
 * Kalder BBR GraphQL for en batch BFE'er og konsoliderer status-signal.
 * Matcher scripts/backfill-bbr-status.mjs fetchBbrStatusForBfeBatch.
 */
async function fetchBbrStatusForBfeBatch(
  bfeNumre: number[]
): Promise<Map<number, BbrStatusResult>> {
  if (bfeNumre.length === 0) return new Map();

  const bbrUser = process.env.DATAFORDELER_USER;
  const bbrPass = process.env.DATAFORDELER_PASS;
  if (!bbrUser || !bbrPass) {
    logger.error('[refresh-ejendom-status] Missing DATAFORDELER credentials');
    return new Map();
  }
  const auth = Buffer.from(`${bbrUser}:${bbrPass}`).toString('base64');

  const query = `query($vt: DafDateTime!, $bfes: [Int!]!) {
    BBR_Grund(first: 500, virkningstid: $vt, where: { bestemtFastEjendomBFENr: { in: $bfes } }) {
      nodes {
        bestemtFastEjendomBFENr
        kommunekode
        husnummer { id_lokalId }
        bygningPaaGrund {
          bygning {
            nodes {
              id_lokalId
              status
              byg038SamletBygningsareal
            }
          }
        }
      }
    }
  }`;

  const vt = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  let res: Response;
  try {
    res = await fetch('https://services.datafordeler.dk/BBR/BBRPublic/1/rest/GraphQL/ejendom', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables: { vt, bfes: bfeNumre } }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    logger.warn(
      '[refresh-ejendom-status] BBR network error:',
      (err as Error)?.message ?? 'unknown'
    );
    return new Map();
  }

  if (!res.ok) {
    logger.warn(`[refresh-ejendom-status] BBR HTTP ${res.status}`);
    return new Map();
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    logger.warn('[refresh-ejendom-status] BBR JSON parse error');
    return new Map();
  }

  const data = json as {
    data?: {
      BBR_Grund?: {
        nodes?: Array<{
          bestemtFastEjendomBFENr?: number | string;
          kommunekode?: number | string | null;
          husnummer?: { id_lokalId?: string | null } | null;
          bygningPaaGrund?: Array<{
            bygning?: {
              nodes?: Array<{
                status?: number | string | null;
                byg038SamletBygningsareal?: number | null;
              }>;
            };
          }> | null;
        }>;
      };
    };
    errors?: unknown;
  };

  if (data.errors) {
    logger.warn(
      '[refresh-ejendom-status] GraphQL errors:',
      JSON.stringify(data.errors).slice(0, 300)
    );
    return new Map();
  }

  const grunde = data.data?.BBR_Grund?.nodes ?? [];
  const byBfe = new Map<
    number,
    {
      bygninger: Array<{
        status?: number | string | null;
        byg038SamletBygningsareal?: number | null;
      }>;
      adgangsadresse_id: string | null;
      kommune_kode: number | null;
    }
  >();

  for (const g of grunde) {
    const bfe = Number(g.bestemtFastEjendomBFENr);
    if (!Number.isFinite(bfe)) continue;

    const kommuneKode = g.kommunekode != null ? parseInt(String(g.kommunekode), 10) : null;
    const adgangsId = g.husnummer?.id_lokalId ?? null;
    const bygninger = (g.bygningPaaGrund ?? [])
      .flatMap((bp) => bp?.bygning?.nodes ?? [])
      .filter((b) => b != null);

    if (!byBfe.has(bfe)) {
      byBfe.set(bfe, { bygninger: [], adgangsadresse_id: null, kommune_kode: null });
    }
    const entry = byBfe.get(bfe)!;
    entry.bygninger.push(...bygninger);
    if (!entry.adgangsadresse_id && adgangsId) entry.adgangsadresse_id = adgangsId;
    if (entry.kommune_kode == null && kommuneKode != null && Number.isFinite(kommuneKode)) {
      entry.kommune_kode = kommuneKode;
    }
  }

  const result = new Map<number, BbrStatusResult>();
  for (const [bfe, entry] of byBfe) {
    if (entry.bygninger.length === 0) {
      result.set(bfe, {
        is_udfaset: false,
        bbr_status_code: null,
        adgangsadresse_id: entry.adgangsadresse_id,
        kommune_kode: entry.kommune_kode,
      });
      continue;
    }

    const allRetired = entry.bygninger.every((b) => {
      const s = Number(b.status);
      return BBR_STATUS_UDFASET.has(s);
    });

    let primaryStatus: number | null = null;
    let maxArea = -1;
    for (const b of entry.bygninger) {
      const area = Number(b.byg038SamletBygningsareal) || 0;
      const s = Number(b.status);
      if (Number.isFinite(s) && area > maxArea) {
        maxArea = area;
        primaryStatus = s;
      }
    }

    result.set(bfe, {
      is_udfaset: allRetired,
      bbr_status_code: primaryStatus,
      adgangsadresse_id: entry.adgangsadresse_id,
      kommune_kode: entry.kommune_kode,
    });
  }

  return result;
}

/**
 * GET endpoint (Vercel cron). Refresher bbr_ejendom_status-rows
 * ældre end 7 dage, cap 5000 pr run.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stale, error: fetchErr } = await (admin as any)
    .from('bbr_ejendom_status')
    .select('bfe_nummer, is_udfaset, bbr_status_code')
    .lt('status_last_checked_at', cutoff)
    .order('status_last_checked_at', { ascending: true })
    .limit(PER_RUN_CAP);

  if (fetchErr) {
    logger.error('[refresh-ejendom-status] fetch fejlede:', fetchErr.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  const rows = (stale ?? []) as Array<{
    bfe_nummer: number;
    is_udfaset: boolean;
    bbr_status_code: number | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, changed: 0, note: 'no stale rows' });
  }

  // Current-state lookup så vi kan tælle changed-count
  const currentByBfe = new Map<number, { is_udfaset: boolean; bbr_status_code: number | null }>();
  for (const r of rows) {
    currentByBfe.set(r.bfe_nummer, {
      is_udfaset: r.is_udfaset,
      bbr_status_code: r.bbr_status_code,
    });
  }

  let checked = 0;
  let changed = 0;
  let upserted = 0;
  let failed = 0;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE).map((r) => r.bfe_nummer);

    let statusMap: Map<number, BbrStatusResult>;
    try {
      statusMap = await fetchBbrStatusForBfeBatch(chunk);
    } catch (err) {
      failed += chunk.length;
      logger.warn('[refresh-ejendom-status] batch fejl:', (err as Error)?.message ?? 'unknown');
      continue;
    }

    const upsertRows = [];
    for (const bfe of chunk) {
      const entry = statusMap.get(bfe);
      if (!entry) continue;
      checked++;
      const current = currentByBfe.get(bfe);
      if (
        current &&
        (current.is_udfaset !== entry.is_udfaset ||
          current.bbr_status_code !== entry.bbr_status_code)
      ) {
        changed++;
      }
      upsertRows.push({
        bfe_nummer: bfe,
        adgangsadresse_id: entry.adgangsadresse_id,
        is_udfaset: entry.is_udfaset,
        bbr_status_code: entry.bbr_status_code,
        kommune_kode: entry.kommune_kode,
        status_last_checked_at: nowIso,
      });
    }

    if (upsertRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upsertErr } = await (admin as any)
        .from('bbr_ejendom_status')
        .upsert(upsertRows, { onConflict: 'bfe_nummer' });
      if (upsertErr) {
        logger.error('[refresh-ejendom-status] upsert fejl:', upsertErr.message);
      } else {
        upserted += upsertRows.length;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    checked,
    changed,
    upserted,
    failed,
    capReached: rows.length >= PER_RUN_CAP,
  });
}
