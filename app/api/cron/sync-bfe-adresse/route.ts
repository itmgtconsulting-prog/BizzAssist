/**
 * GET /api/cron/sync-bfe-adresse
 *
 * BIZZ-1670: Daglig cron-job der finder nye BFE'er i ejf_ejerskab uden
 * cached adresse og prøver at resolve dem via DAWA + VP.
 *
 * Kører som Vercel cron (schedule: "0 5 * * *" — kl 05:00 UTC dagligt).
 * Max 50 BFE'er per kørsel for at holde execution time under 30s.
 *
 * @module api/cron/sync-bfe-adresse
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { fetchDawa } from '@/app/lib/dawa';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';

export const maxDuration = 30;

/** Verify cron secret in production */
function verifyCron(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization');
  const isCron = request.headers.get('x-vercel-cron') === '1';
  return auth === `Bearer ${secret}` || isCron;
}

/**
 * GET handler — sync missing BFE addresses.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const BATCH_LIMIT = 50;

  try {
    // Find BFE'er i ejf_ejerskab uden cached adresse
    const { data: allEjf } = await admin
      .from('ejf_ejerskab')
      .select('bfe_nummer')
      .eq('status', 'gældende')
      .limit(5000);

    const { data: allCached } = await admin.from('bfe_adresse_cache').select('bfe_nummer');

    const cachedSet = new Set((allCached ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer));
    const missing = [...new Set((allEjf ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer))]
      .filter((b) => !cachedSet.has(b))
      .slice(0, BATCH_LIMIT);

    if (missing.length === 0) {
      return NextResponse.json({ synced: 0, message: 'Alle BFE-adresser er cached' });
    }

    let resolved = 0;

    for (const bfe of missing) {
      try {
        // Fallback 1: DAWA /bfe
        const dawaRes = await fetchDawa(
          `${DAWA_BASE_URL}/bfe/${bfe}`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
          { caller: 'cron.sync-bfe-adresse' }
        );

        if (dawaRes.ok) {
          const json = await dawaRes.json();
          const bel = (
            json as {
              beliggenhedsadresse?: {
                vejnavn?: string;
                husnr?: string;
                etage?: string;
                dør?: string;
                postnr?: string;
                postnrnavn?: string;
                kommunenavn?: string;
                kommunekode?: string;
                id?: string;
              };
            }
          ).beliggenhedsadresse;
          if (bel?.vejnavn) {
            await admin.from('bfe_adresse_cache').upsert(
              {
                bfe_nummer: bfe,
                adresse: `${bel.vejnavn} ${bel.husnr ?? ''}`.trim(),
                etage: bel.etage ?? null,
                doer: bel.dør ?? null,
                postnr: bel.postnr ?? null,
                postnrnavn: bel.postnrnavn ?? null,
                kommune: bel.kommunenavn ?? null,
                kommune_kode: bel.kommunekode ?? null,
                dawa_id: bel.id ?? null,
                ejendomstype: (json as { ejendomstype?: string }).ejendomstype ?? null,
                kilde: 'cron_dawa',
                sidst_opdateret: new Date().toISOString(),
              },
              { onConflict: 'bfe_nummer' }
            );
            resolved++;
            continue;
          }
        }

        // Fallback 2: VP ES
        const vpRes = await fetch(
          'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            body: JSON.stringify({
              query: { term: { bfeNumbers: bfe } },
              size: 1,
              _source: [
                'roadName',
                'houseNumber',
                'zipcode',
                'postDistrict',
                'floor',
                'door',
                'adgangsAdresseID',
              ],
            }),
            signal: AbortSignal.timeout(5000),
          }
        );

        if (vpRes.ok) {
          const vpData = (await vpRes.json()) as {
            hits?: { hits?: Array<{ _source?: Record<string, string> }> };
          };
          const src = vpData.hits?.hits?.[0]?._source;
          if (src?.roadName) {
            await admin.from('bfe_adresse_cache').upsert(
              {
                bfe_nummer: bfe,
                adresse: `${src.roadName} ${src.houseNumber ?? ''}`.trim(),
                etage: src.floor ?? null,
                doer: src.door ?? null,
                postnr: src.zipcode ?? null,
                postnrnavn: src.postDistrict ?? null,
                dawa_id: src.adgangsAdresseID ?? null,
                kilde: 'cron_vp',
                sidst_opdateret: new Date().toISOString(),
              },
              { onConflict: 'bfe_nummer' }
            );
            resolved++;
          }
        }
      } catch {
        /* individual BFE failure non-fatal */
      }
    }

    logger.log(`[sync-bfe-adresse] Synced ${resolved}/${missing.length} BFE addresses`);
    return NextResponse.json({ synced: resolved, missing: missing.length });
  } catch (err) {
    logger.error('[sync-bfe-adresse] Error:', err);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}
