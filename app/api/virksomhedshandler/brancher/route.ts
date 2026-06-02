/**
 * GET /api/virksomhedshandler/brancher
 *
 * Returnerer de brancher (DB07) der optræder blandt virksomhedshandel-kandidater,
 * sorteret efter antal kandidater (faldende). Bruges til at populere branche-
 * multiselect-filteret på M&A-radaren.
 *
 * Aggregeringen over den ~1,2 mio. rækker store MV er dyr (~18s), så resultatet
 * caches in-memory i 6 timer. Første kald efter cold-start er langsomt; herefter
 * serveres listen øjeblikkeligt fra cache.
 *
 * Ingen vedvarende lagring af kandidatdata — kun en flygtig optælling.
 *
 * @returns { brancher: Array<{ branche_kode, branche_tekst, antal }> }
 *
 * @module app/api/virksomhedshandler/brancher/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

interface BrancheOption {
  branche_kode: string;
  branche_tekst: string;
  antal: number;
}

// ─── In-memory cache (6h TTL) ─────────────────────────────────────────────────

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cached: { data: BrancheOption[]; ts: number } | null = null;

/**
 * GET handler — henter branche-optioner (cachet 6t).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(req, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Ikke autentificeret' }, { status: 401 });
  }

  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json({ brancher: cached.data });
  }

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').match(/\/\/([^.]+)/)?.[1];
  if (!accessToken || !projectRef) {
    return NextResponse.json({ error: 'Mangler SUPABASE_ACCESS_TOKEN' }, { status: 503 });
  }

  try {
    const sql = `SELECT v.branche_kode, v.branche_tekst, COUNT(*)::int AS antal
      FROM mv_virksomhedshandel_kandidater k
      JOIN cvr_virksomhed v ON v.cvr = k.virksomhed_cvr
      WHERE k.signal_type != 'unchanged' AND v.branche_kode IS NOT NULL AND v.branche_tekst IS NOT NULL
      GROUP BY v.branche_kode, v.branche_tekst
      ORDER BY antal DESC
      LIMIT 500`;

    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(28000),
    });
    const json = await res.json();
    const data: BrancheOption[] = Array.isArray(json) ? json : [];
    cached = { data, ts: Date.now() };
    return NextResponse.json({ brancher: data });
  } catch (err) {
    logger.error('[virksomhedshandler/brancher] catch', { error: err });
    // Servér evt. forældet cache hellere end at fejle filter-panelet.
    if (cached) return NextResponse.json({ brancher: cached.data });
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 502 });
  }
}
