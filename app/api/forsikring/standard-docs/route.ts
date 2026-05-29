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
  added_via: z.enum(['ai_discovery', 'manual_link', 'auto_detected']),
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
  /** UUID af brugeren der tilføjede — til slet-kontrol */
  added_by_user: string | null;
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

    // Domain-scoped: vis kun betingelser fra brugerens tenant/domain
    // Globale docs (added_by_domain = null) vises altid (system-level)
    const domainId = auth.tenantId;

    // ?all=true → vis ALLE docs uanset domain (til admin/debugging)
    const showAll = req.nextUrl.searchParams.get('all') === 'true';

    let query = serviceClient
      .from('forsikring_standard_doc')
      .select(
        'id, selskab, kategori, titel, source_url, added_via, verified, created_at, raw_content, added_by_user'
      )
      .order('created_at', { ascending: false })
      .limit(100);

    // Filter til brugerens domain + globale docs (uden domain)
    if (!showAll && domainId) {
      query = query.or(`added_by_domain.eq.${domainId},added_by_domain.is.null`);
    }

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
        added_by_user: string | null;
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
      added_by_user: d.added_by_user,
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

// ─── DELETE ──────────────────────────────────────────────────────────────────

/**
 * DELETE /api/forsikring/standard-docs?id=UUID
 * Sletter et standard-dokument. Brugere kan kun slette egne docs.
 */
export async function DELETE(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const docId = req.nextUrl.searchParams.get('id');
    if (!docId) {
      return NextResponse.json({ error: 'id parameter påkrævet' }, { status: 400 });
    }

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

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Kun slet egne docs (added_by_user match) eller docs i eget domain
    const { error } = await serviceClient
      .from('forsikring_standard_doc')
      .delete()
      .eq('id', docId)
      .eq('added_by_domain', auth.tenantId);

    if (error) {
      logger.error('[standard-docs DELETE] error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[standard-docs DELETE] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}

// ─── PATCH ──────────────────────────────────────────────────────────────────

/**
 * PATCH /api/forsikring/standard-docs?id=UUID
 * Opdaterer titel, selskab og/eller gyldig_fra.
 */
export async function PATCH(req: NextRequest) {
  try {
    const auth = await resolveTenantId();
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const docId = req.nextUrl.searchParams.get('id');
    if (!docId) {
      return NextResponse.json({ error: 'id parameter påkrævet' }, { status: 400 });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json({ error: 'Supabase ikke konfigureret' }, { status: 503 });
    }

    const body = (await req.json()) as {
      titel?: string;
      selskab?: string;
      gyldig_fra?: string | null;
    };

    const updates: Record<string, unknown> = {};
    if (body.titel) updates.titel = body.titel;
    if (body.selskab) updates.selskab = body.selskab;
    if ('gyldig_fra' in body) updates.gyldig_fra = body.gyldig_fra || null;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Ingen felter at opdatere' }, { status: 400 });
    }

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { error } = await serviceClient
      .from('forsikring_standard_doc')
      .update(updates)
      .eq('id', docId)
      .eq('added_by_domain', auth.tenantId);

    if (error) {
      logger.error('[standard-docs PATCH] error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[standard-docs PATCH] uventet fejl:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
