/**
 * GET  /api/forsikring/standard-docs?selskab=Topdanmark
 *   Returnerer standard forsikringsbetingelser for et selskab.
 *   Valgfri filter: ?kategori=ejendom
 *
 * POST /api/forsikring/standard-docs
 *   Tilføjer et nyt standard-dokument (manuel link eller AI-discovery).
 *   Body: { selskab, kategori, titel, source_url, raw_content?, added_via }
 *
 * @module app/api/forsikring/standard-docs/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import crypto from 'crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** Zod schema for POST body */
const PostSchema = z.object({
  selskab: z.string().min(1),
  kategori: z.string().min(1),
  titel: z.string().min(1),
  source_url: z.string().url(),
  raw_content: z.string().optional(),
  added_via: z.enum(['ai_discovery', 'manual_link']),
});

/** Standard-doc returneret til frontend */
export interface StandardDocSummary {
  id: string;
  selskab: string;
  kategori: string;
  titel: string;
  source_url: string;
  added_via: string;
  verified: boolean;
  created_at: string;
  has_content: boolean;
}

/**
 * Returnerer Supabase server-client med cookie-baseret session.
 *
 * @returns Supabase client med bruger-auth
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

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const selskab = req.nextUrl.searchParams.get('selskab');
    const kategori = req.nextUrl.searchParams.get('kategori');

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json([], { status: 200 });
    }

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    let query = serviceClient
      .from('forsikring_standard_doc')
      .select(
        'id, selskab, kategori, titel, source_url, added_via, verified, created_at, raw_content'
      )
      .order('created_at', { ascending: false })
      .limit(100);

    if (selskab) query = query.ilike('selskab', `%${selskab}%`);
    if (kategori) query = query.eq('kategori', kategori);

    const { data, error } = await query;

    if (error) {
      logger.error('[standard-docs GET] query error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const result: StandardDocSummary[] = (
      (data ?? []) as Array<{
        id: string;
        selskab: string;
        kategori: string;
        titel: string;
        source_url: string;
        added_via: string;
        verified: boolean;
        created_at: string;
        raw_content: string | null;
      }>
    ).map((d) => ({
      id: d.id,
      selskab: d.selskab,
      kategori: d.kategori,
      titel: d.titel,
      source_url: d.source_url,
      added_via: d.added_via,
      verified: d.verified,
      created_at: d.created_at,
      has_content: !!d.raw_content,
    }));

    return NextResponse.json(result);
  } catch (err) {
    logger.error('[standard-docs GET] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
    }

    const sessionClient = await getSessionClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });
    }

    const parsed = PostSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Ugyldigt input', details: parsed.error.format() },
        { status: 400 }
      );
    }
    const { selskab, kategori, titel, source_url, raw_content, added_via } = parsed.data;

    // Content hash for dedup
    const hashInput = raw_content ?? source_url;
    const content_hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Upsert — dedup via content_hash
    const { data, error } = await serviceClient
      .from('forsikring_standard_doc')
      .upsert(
        {
          selskab,
          kategori,
          titel,
          source_url,
          content_hash,
          raw_content: raw_content ?? null,
          parsed_at: raw_content ? new Date().toISOString() : null,
          added_via,
          added_by_user: user.id,
          added_by_domain: auth.tenantId,
        },
        { onConflict: 'content_hash' }
      )
      .select('id')
      .single();

    if (error) {
      logger.error('[standard-docs POST] upsert error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ id: data?.id, success: true });
  } catch (err) {
    logger.error('[standard-docs POST] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
