/**
 * GET    /api/link-verification?cvr=XXXX
 *   Returnerer alle verificeringer for et CVR-nummer inkl. brugerens egne
 *   og aggregerede counts (verified_count, rejected_count) per link_url.
 *
 * POST   /api/link-verification
 *   Body: { cvr, link_url, link_type?, platform?, verdict }
 *   Gemmer eller opdaterer brugerens verdict (upsert via UNIQUE constraint).
 *   user_id hentes fra Supabase auth-session.
 *
 * DELETE /api/link-verification?cvr=XXXX&link_url=XXXX
 *   Fjerner brugerens verdict (trækker stemme tilbage).
 *   user_id hentes fra Supabase auth-session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

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

/** Aggregeret count-række fra link_verification_counts view */
interface CountRow {
  cvr: string;
  link_url: string;
  platform: string | null;
  link_type: string | null;
  verified_count: number;
  rejected_count: number;
}

/** Brugerens egne verdict-rækker */
interface VerdictRow {
  link_url: string;
  verdict: 'verified' | 'rejected';
  platform: string | null;
  link_type: string | null;
}

/** Svar-shape per link_url til frontend */
export interface LinkVerificationSummary {
  link_url: string;
  platform: string | null;
  link_type: string | null;
  verified_count: number;
  rejected_count: number;
  /** Brugerens eget valg — null = ingen stemme */
  user_verdict: 'verified' | 'rejected' | null;
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const cvr = req.nextUrl.searchParams.get('cvr') ?? '';
  if (!cvr) {
    return NextResponse.json({ error: 'cvr er påkrævet' }, { status: 400 });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json([], { status: 200 });
  }

  // Service-client til at hente aggregerede counts (bypasser RLS for reads)
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Hent brugerens session via cookie-client
  const sessionClient = await getSessionClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();

  // Hent aggregerede counts for alle links under dette CVR
  const { data: counts, error: countsErr } = await serviceClient
    .from('link_verification_counts')
    .select('cvr, link_url, platform, link_type, verified_count, rejected_count')
    .eq('cvr', cvr);

  if (countsErr) {
    logger.error('[link-verification GET] counts error:', countsErr.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  // Hent brugerens egne verdicts (kun hvis autentificeret)
  const userVerdicts = new Map<string, 'verified' | 'rejected'>();
  if (user) {
    const { data: ownVerdicts } = await serviceClient
      .from('link_verifications')
      .select('link_url, verdict, platform, link_type')
      .eq('cvr', cvr)
      .eq('user_id', user.id);

    for (const row of (ownVerdicts ?? []) as VerdictRow[]) {
      userVerdicts.set(row.link_url, row.verdict);
    }
  }

  // Sammensæt svar
  const result: LinkVerificationSummary[] = (counts as CountRow[]).map((c) => ({
    link_url: c.link_url,
    platform: c.platform,
    link_type: c.link_type,
    verified_count: Number(c.verified_count),
    rejected_count: Number(c.rejected_count),
    user_verdict: userVerdicts.get(c.link_url) ?? null,
  }));

  return NextResponse.json(result);
}

// ─── POST ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
  }

  // Validér session
  const sessionClient = await getSessionClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
  }

  const body = await req.json();
  const { cvr, link_url, link_type, platform, verdict } = body as {
    cvr?: string;
    link_url?: string;
    link_type?: string;
    platform?: string;
    verdict?: string;
  };

  if (!cvr || !link_url || !verdict) {
    return NextResponse.json({ error: 'cvr, link_url og verdict er påkrævet' }, { status: 400 });
  }
  if (verdict !== 'verified' && verdict !== 'rejected') {
    return NextResponse.json(
      { error: 'verdict skal være "verified" eller "rejected"' },
      { status: 400 }
    );
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Upsert: UNIQUE (user_id, cvr, link_url) — opdatér verdict hvis rækken eksisterer
  const { error } = await serviceClient.from('link_verifications').upsert(
    {
      user_id: user.id,
      cvr,
      link_url,
      link_type: link_type ?? null,
      platform: platform ?? null,
      verdict,
    },
    { onConflict: 'user_id,cvr,link_url' }
  );

  if (error) {
    logger.error('[link-verification POST] upsert error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
  }

  // Validér session
  const sessionClient = await getSessionClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
  }

  const cvr = req.nextUrl.searchParams.get('cvr') ?? '';
  const link_url = req.nextUrl.searchParams.get('link_url') ?? '';

  if (!cvr || !link_url) {
    return NextResponse.json({ error: 'cvr og link_url er påkrævet' }, { status: 400 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { error } = await serviceClient
    .from('link_verifications')
    .delete()
    .eq('user_id', user.id)
    .eq('cvr', cvr)
    .eq('link_url', link_url);

  if (error) {
    logger.error('[link-verification DELETE] delete error:', error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
