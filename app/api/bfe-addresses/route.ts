/**
 * GET /api/bfe-addresses?bfes=1,2,3
 *
 * BIZZ-581: Lightweight batch-endpoint der beriger BFE-numre med adresse +
 * dawaId så de kan vises som korrekte ejendomsbokse i diagrammer.
 * Bruges når BFE-numre kommer fra bulk-data (BIZZ-534 person-bridge) uden
 * adresse-information.
 *
 * Returnerer: { [bfe]: { adresse, postnr, by, kommune, dawaId, ejendomstype, etage, doer } }
 *
 * BIZZ-2093: Opslag sker via den fælles resolver i app/lib/bfeAdresse.ts
 * (cache-first med troværdig kilde + jordstykke-baseret live-fallback).
 * Cache: 24 timer.
 *
 * @module api/bfe-addresses
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { hentBfeAdresser } from '@/app/lib/bfeAdresse';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** Maks BFE'er per kald — beskytter mod misbrug */
const MAX_BATCH = 50;

const querySchema = z.object({
  bfes: z.string().regex(/^[\d,]+$/, 'bfes skal være komma-separeret tal'),
});

interface AdresseRow {
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  kommune: string | null;
  dawaId: string | null;
  ejendomstype: string | null;
  etage: string | null;
  doer: string | null;
}

const empty = (): AdresseRow => ({
  adresse: null,
  postnr: null,
  by: null,
  kommune: null,
  dawaId: null,
  ejendomstype: null,
  etage: null,
  doer: null,
});

/**
 * GET /api/bfe-addresses
 * Batch-resolve BFE-numre → adresse + dawaId.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(request, querySchema);
  if (!parsed.success) return parsed.response;
  const { bfes } = parsed.data;

  const list = bfes.split(',').filter(Boolean).slice(0, MAX_BATCH);

  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    // BIZZ-2093: Fælles resolver — cache-first (kun troværdige kilder) +
    // valideret jordstykke-baseret live-fallback + VP for ejerlejligheder.
    // Erstatter den gamle kæde (bbr_ejendom_status → nedlagt DAWA /bfe → VP)
    // der kunne give SFE-gruppens hovedadresse til alle BFE'er i en gruppe.
    const bfeNums = list.map((b) => parseInt(b, 10)).filter((n) => !isNaN(n));
    const resolved = await hentBfeAdresser(bfeNums);
    const out: Record<string, AdresseRow> = {};
    for (const b of list) {
      const r = resolved.get(parseInt(b, 10));
      out[b] = r
        ? {
            adresse: r.adresse,
            postnr: r.postnr,
            by: r.by,
            kommune: r.kommune,
            dawaId: r.dawaId,
            ejendomstype: r.ejendomstype,
            etage: r.etage,
            doer: r.doer,
          }
        : empty();
    }

    // BIZZ-2047: Tinglysning fallback for BFE'er uden adresse.
    // Max 3 pr. request for at undgå e-TL rate-limiting.
    const unresolved = Object.entries(out)
      .filter(([, v]) => !v.adresse)
      .slice(0, 3);
    if (unresolved.length > 0) {
      const cookie = request.headers.get('cookie') ?? '';
      const proto = request.headers.get('x-forwarded-proto') ?? 'https';
      const host = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
      for (const [bfe] of unresolved) {
        try {
          const tlRes = await fetch(`${host}/api/tinglysning?bfe=${bfe}`, {
            headers: { cookie },
            signal: AbortSignal.timeout(8000),
          });
          if (!tlRes.ok) continue;
          const tlData = await tlRes.json();
          if (tlData?.adresse) {
            const parts = tlData.adresse.split(',').map((s: string) => s.trim());
            const street = parts[0] ?? null;
            const postBy = parts[1]?.split(' ') ?? [];
            const postnr = postBy[0] ?? null;
            const by = postBy.slice(1).join(' ') || null;
            out[bfe] = {
              adresse: street,
              postnr,
              by,
              kommune: null,
              dawaId: null,
              ejendomstype: tlData.ejendomstype ?? null,
              etage: null,
              doer: null,
            };
            // Opdater cache asynkront (fire-and-forget)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            void (admin as any)
              .from('bfe_adresse_cache')
              .update({
                adresse: street,
                postnr,
                postnrnavn: by,
                ejendomstype: tlData.ejendomstype ?? null,
                kilde: 'tinglysning_resolve',
                sidst_opdateret: new Date().toISOString(),
                next_retry_after: null,
              })
              .eq('bfe_nummer', Number(bfe))
              .then(() => {});
          }
        } catch {
          // TL-fallback er best-effort
        }
      }
    }

    return NextResponse.json(out, {
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=21600',
      },
    });
  } catch (err) {
    logger.error('[bfe-addresses] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
