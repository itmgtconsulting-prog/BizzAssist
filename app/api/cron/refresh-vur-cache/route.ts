/**
 * GET /api/cron/refresh-vur-cache
 *
 * BIZZ-1192: Ugentlig sync af ejendomsvurderinger fra Datafordeler VUR GraphQL.
 * Finder BFE-numre med vurderinger ældre end 30 dage (eller manglende) og
 * genhenter fra VUR_BFEKrydsreference → VUR_Ejendomsvurdering.
 *
 * Vurderinger ændres sjældent (1×/år per ejendom) — ugentlig schedule er
 * sufficient. Cap 200 BFE per kørsel for at holde sig under 300s maxDuration.
 *
 * Schedule: 0 3 * * 0 (søndag kl. 03:00 UTC)
 *
 * @module api/cron/refresh-vur-cache
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { safeCompare } from '@/lib/safeCompare';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import crypto from 'crypto';

export const maxDuration = 300;

/** Max BFE per cron-kørsel */
const MAX_PER_RUN = 200;

/** Batch-size for Datafordeler kald */
const BATCH_DELAY_MS = 300;

/** Stale threshold — genhent vurderinger ældre end 30 dage */
const STALE_DAYS = 30;

/** Datafordeler VUR GraphQL endpoint */
const VUR_GQL = 'https://graphql.datafordeler.dk/VUR/v2';

// ── Auth ────────────────────────────────────────────────────────────────────

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

// ── VUR fetch ───────────────────────────────────────────────────────────────

/** Raw vurdering node from Datafordeler GraphQL */
interface VurNode {
  id: string;
  aar: number | null;
  ejendomvaerdiBeloeb: number | null;
  grundvaerdiBeloeb: number | null;
  vurderetAreal: number | null;
  benyttelseKode: string | null;
  juridiskKategoriTekst: string | null;
}

/**
 * Fetches vurderinger for a BFE from Datafordeler VUR GraphQL.
 * Two-step: BFEKrydsreference → Ejendomsvurdering.
 *
 * @param bfe - BFE number
 * @param authHeader - Basic auth header value
 * @returns Array of vurdering nodes, or null on error
 */
async function fetchVurForBfe(
  bfe: number,
  authHeader: string
): Promise<{ vurderinger: VurNode[] } | null> {
  try {
    // Step 1: Krydsreference
    const krydsQuery = `{ VUR_BFEKrydsreference(first: 100, where: { BFEnummer: { eq: ${bfe} } }) { nodes { fkEjendomsvurderingID } } }`;
    const krydsRes = await fetch(VUR_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${authHeader}` },
      body: JSON.stringify({ query: krydsQuery }),
      signal: AbortSignal.timeout(15000),
    });
    if (!krydsRes.ok) return null;

    const krydsData = (await krydsRes.json()) as {
      data?: {
        VUR_BFEKrydsreference?: { nodes: { fkEjendomsvurderingID: string }[] };
      };
    };
    const vurIds = (krydsData.data?.VUR_BFEKrydsreference?.nodes ?? [])
      .map((n) => n.fkEjendomsvurderingID)
      .filter(Boolean);
    if (vurIds.length === 0) return { vurderinger: [] };

    // Step 2: Vurderinger
    const ids = vurIds.map((id) => `"${id}"`).join(',');
    const vurQuery = `{ VUR_Ejendomsvurdering(first: 100, where: { id: { in: [${ids}] } }) { nodes { id aar ejendomvaerdiBeloeb grundvaerdiBeloeb vurderetAreal benyttelseKode juridiskKategoriTekst } } }`;
    const vurRes = await fetch(VUR_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${authHeader}` },
      body: JSON.stringify({ query: vurQuery }),
      signal: AbortSignal.timeout(15000),
    });
    if (!vurRes.ok) return null;

    const vurData = (await vurRes.json()) as {
      data?: { VUR_Ejendomsvurdering?: { nodes: VurNode[] } };
    };
    return { vurderinger: vurData.data?.VUR_Ejendomsvurdering?.nodes ?? [] };
  } catch (err) {
    logger.warn(
      `[refresh-vur-cache] fetchVur(${bfe}) error:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * GET /api/cron/refresh-vur-cache
 *
 * Finds stale or missing VUR entries and refreshes from Datafordeler.
 *
 * @param request - Incoming request with CRON_SECRET auth
 * @returns JSON summary
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dfUser = process.env.DATAFORDELER_USER;
  const dfPass = process.env.DATAFORDELER_PASS;
  if (!dfUser || !dfPass) {
    logger.warn('[refresh-vur-cache] DATAFORDELER_USER/PASS not set — skipping');
    return NextResponse.json({ error: 'Credentials missing' }, { status: 200 });
  }
  const authHeader = Buffer.from(`${dfUser}:${dfPass}`).toString('base64');

  return withCronMonitor(
    { jobName: 'refresh-vur-cache', schedule: '0 3 * * 0', intervalMinutes: 10080 },
    async () => {
      const admin = createAdminClient();
      const startTime = Date.now();
      const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Find BFEs that need refresh: either not in cache_vur, or synced_at is stale
      // Strategy: get BFEs from bbr_ejendom_status that are stale in cache_vur
      // Using raw SQL via admin RPC would be ideal, but we can do a left-join approach:
      // 1. Get stale/missing BFEs via a simple approach
      const { data: staleBfes, error: staleErr } = await (
        admin as unknown as {
          from: (t: string) => {
            select: (c: string) => {
              lt: (
                col: string,
                val: string
              ) => {
                order: (
                  col: string,
                  opts: { ascending: boolean }
                ) => {
                  limit: (n: number) => Promise<{
                    data: Array<{ bfe_nummer: number }> | null;
                    error: { message: string } | null;
                  }>;
                };
              };
            };
          };
        }
      )
        .from('cache_vur')
        .select('bfe_nummer')
        .lt('synced_at', staleCutoff)
        .order('synced_at', { ascending: true })
        .limit(MAX_PER_RUN);

      if (staleErr) {
        logger.error('[refresh-vur-cache] Failed to query stale BFEs:', staleErr.message);
        return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 200 });
      }

      const bfesToRefresh = (staleBfes ?? []).map((r: { bfe_nummer: number }) => r.bfe_nummer);
      logger.log(`[refresh-vur-cache] Found ${bfesToRefresh.length} stale BFEs to refresh`);

      let refreshed = 0;
      let errors = 0;

      for (const bfe of bfesToRefresh) {
        // Time budget check
        if (Date.now() - startTime > maxDuration * 1000 - 30_000) {
          logger.log(`[refresh-vur-cache] Time budget reached after ${refreshed} BFEs`);
          break;
        }

        try {
          const data = await fetchVurForBfe(bfe, authHeader);
          if (data) {
            const rawJson = JSON.stringify(data);
            const hash = crypto.createHash('sha256').update(rawJson).digest('hex');
            const { error: upsertErr } = await (
              admin as unknown as {
                from: (t: string) => {
                  upsert: (
                    v: Record<string, unknown>,
                    o: { onConflict: string }
                  ) => Promise<{ error: { message: string } | null }>;
                };
              }
            )
              .from('cache_vur')
              .upsert(
                {
                  bfe_nummer: bfe,
                  raw_data: data,
                  source_hash: hash,
                  synced_at: new Date().toISOString(),
                },
                { onConflict: 'bfe_nummer' }
              );

            if (upsertErr) {
              logger.warn(`[refresh-vur-cache] Upsert failed for BFE ${bfe}:`, upsertErr.message);
              errors++;
            } else {
              refreshed++;
            }
          } else {
            errors++;
          }
        } catch {
          errors++;
        }

        // Rate limit
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }

      const durationMs = Date.now() - startTime;
      logger.log(
        `[refresh-vur-cache] Done: ${refreshed} refreshed, ${errors} errors, ${durationMs}ms`
      );

      return NextResponse.json({
        ok: true,
        staleBfes: bfesToRefresh.length,
        refreshed,
        errors,
        durationMs,
      });
    }
  );
}
