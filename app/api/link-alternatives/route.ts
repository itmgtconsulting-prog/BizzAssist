/**
 * GET  /api/link-alternatives?cvr=XXXX
 *   Returnerer alle alternative links per platform for et CVR-nummer.
 *   Svar-shape: { [platform]: string[] }
 *
 * PUT  /api/link-alternatives
 *   Body: { cvr: string, alternatives: { [platform]: string[] } }
 *   Upsert-gemmer alternative links for alle platforme i ét kald.
 *   Kræver authenticated Supabase-session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for PUT /api/link-alternatives request body */
const linkAlternativesPutSchema = z.object({
  cvr: z.string().min(1),
  alternatives: z.record(z.string(), z.array(z.string())),
}).passthrough();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * Returnerer Supabase server-client med cookie-baseret session (bruger-auth).
 */
async function getSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        /* read-only i route handlers */
      },
    },
  });
}

/** Række fra link_alternatives-tabellen */
interface AlternativeRow {
  platform: string;
  alternatives: string[];
}

// ─── GET ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/link-alternatives?cvr=XXXX
 * Returnerer alle gemte alternative links per platform for et CVR-nummer.
 *
 * @returns { [platform]: string[] } — tom map hvis ingen alternativer er gemt
 */
export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cvr = req.nextUrl.searchParams.get('cvr') ?? '';
  if (!cvr) {
    return NextResponse.json({ error: 'cvr er påkrævet' }, { status: 400 });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({}, { status: 200 });
  }

  try {
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data, error } = await serviceClient
      .from('link_alternatives')
      .select('platform, alternatives')
      .eq('cvr', cvr);

    if (error) {
      logger.error('[link-alternatives GET] Supabase fejl:', error.message);
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    const result: Record<string, string[]> = {};
    for (const row of (data ?? []) as AlternativeRow[]) {
      if (Array.isArray(row.alternatives)) {
        result[row.platform] = row.alternatives;
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error('[link-alternatives GET] Uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}

// ─── PUT ────────────────────────────────────────────────────────────────────

/**
 * PUT /api/link-alternatives
 * Upsert-gemmer alternative links for alle platforme for et CVR-nummer.
 * Kræver authenticated Supabase-session.
 *
 * @param body.cvr - CVR-nummer for virksomheden
 * @param body.alternatives - Map fra platform til array af alternative URLs
 * @returns { success: true } ved succes
 */
export async function PUT(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
  }

  try {
    // Validér session
    const sessionClient = await getSessionClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
    }

    const parsed = await parseBody(req, linkAlternativesPutSchema);
    if (!parsed.success) return parsed.response;
    const { cvr, alternatives } = parsed.data;

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Upsert én række per platform — UNIQUE (cvr, platform)
    const rows = Object.entries(alternatives)
      .filter(([, alts]) => Array.isArray(alts) && alts.length > 0)
      .map(([platform, alts]) => ({
        cvr,
        platform,
        alternatives: alts.slice(0, 5),
        updated_at: new Date().toISOString(),
      }));

    if (rows.length === 0) {
      return NextResponse.json({ success: true, saved: 0 });
    }

    const { error } = await serviceClient
      .from('link_alternatives')
      .upsert(rows, { onConflict: 'cvr,platform' });

    if (error) {
      logger.error('[link-alternatives PUT] Supabase fejl:', error.message);
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    return NextResponse.json({ success: true, saved: rows.length });
  } catch (err) {
    logger.error('[link-alternatives PUT] Uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
