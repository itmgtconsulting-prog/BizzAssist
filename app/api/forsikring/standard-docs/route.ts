/**
 * GET  /api/forsikring/standard-docs?selskab=Topdanmark
 *   Returnerer standard forsikringsbetingelser for et selskab.
 *   Valgfri filter: ?kategori=ejendom
 *   BIZZ-2078: ?kunde_id=<cvr> — kun betingelser brugt i kundens tidligere
 *   analyser (tom liste for ny kunde uden analyser).
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
import { getTenantSchemaName } from '@/lib/db/tenant';
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
    const kundeId = req.nextUrl.searchParams.get('kunde_id');

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return NextResponse.json([], { status: 200 });
    }

    // BIZZ-2078: kunde_id-scoping — returnér kun std docs der tidligere er
    // brugt i analyser for denne forsikringsejer (via junction-tabellen).
    // En ny kunde uden analyser får en tom liste; betingelser tilvælges så
    // via Bibliotek i stedet for at hele domain-biblioteket vises som default.
    let kundeStdDocIds: string[] | null = null;
    if (kundeId) {
      const schemaName = await getTenantSchemaName(auth.tenantId);
      if (!schemaName) return NextResponse.json([], { status: 200 });
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tenantDb = (admin as any).schema(schemaName);
      const { data: analyser } = await tenantDb
        .from('forsikring_analyser')
        .select('id')
        .eq('kunde_id', kundeId)
        .limit(500);
      const analyseIds = ((analyser ?? []) as Array<{ id: string }>).map((a) => a.id);
      if (analyseIds.length === 0) return NextResponse.json([]);
      const { data: links } = await admin
        .from('forsikring_analyse_standard_docs')
        .select('standard_doc_id')
        .in('analyse_id', analyseIds)
        .limit(1000);
      kundeStdDocIds = [
        ...new Set(
          ((links ?? []) as Array<{ standard_doc_id: string }>).map((l) => l.standard_doc_id)
        ),
      ];
      if (kundeStdDocIds.length === 0) return NextResponse.json([]);
    }

    // BIZZ-1907: Brug session-client der respekterer RLS visibility-scoping.
    // Kun egne (private) + domain-delte + curated docs returneres.
    const sessionClient = await getSessionClient();

    let query = sessionClient
      .from('forsikring_standard_doc')
      .select(
        'id, selskab, kategori, titel, source_url, added_via, verified, created_at, raw_content, added_by_user, omraade, gyldig_fra, is_valid_standard, visibility'
      )
      .order('created_at', { ascending: false })
      .limit(100);

    if (selskab) query = query.ilike('selskab', `%${selskab}%`);
    if (kategori) query = query.eq('kategori', kategori);
    // BIZZ-2078: Begræns til std docs brugt i kundens tidligere analyser
    if (kundeStdDocIds) query = query.in('id', kundeStdDocIds);

    const { data, error } = await query;

    if (error) {
      logger.error('[standard-docs GET] query error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const result = (
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
        omraade: string | null;
        gyldig_fra: string | null;
        is_valid_standard: boolean;
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
      omraade: d.omraade,
      gyldig_fra: d.gyldig_fra,
      is_valid_standard: d.is_valid_standard,
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

    // BIZZ-1907: Sæt visibility baseret på domain-membership.
    // Domain-members deler automatisk; standalone-users er private.
    let visibility: 'private' | 'domain' = 'private';
    if (auth.tenantId) {
      // Check domain membership via raw SQL to avoid eslint domain_ restriction
      const { createAdminClient: makeAdmin } = await import('@/lib/supabase/admin');
      const adminC = makeAdmin();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-restricted-syntax
      const { data: dmRow } = await (adminC as any)
        .from('domain_member')
        .select('domain_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();
      if (dmRow?.domain_id) {
        visibility = 'domain';
      }
    }

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
          visibility,
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
