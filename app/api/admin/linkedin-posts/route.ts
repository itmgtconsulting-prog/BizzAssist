/**
 * CRUD /api/admin/linkedin-posts
 *
 * BIZZ-2039: Admin-only CRUD for kuraterede LinkedIn-posts.
 * GET — list alle posts (inkl. inactive)
 * POST — opret ny post
 * PUT — opdater eksisterende post
 * DELETE — slet post
 *
 * Auth: app_metadata.isAdmin=true påkrævet.
 *
 * @module app/api/admin/linkedin-posts
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

/**
 * Verificer admin-rolle via fresh app_metadata.
 *
 * @returns Bruger-ID eller null
 */
async function requireAdmin(): Promise<{ userId: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return { userId: user.id };
  return null;
}

const postSchema = z.object({
  post_url: z.string().url().min(1),
  image_url: z.string().url().optional().nullable(),
  excerpt_da: z.string().min(1).max(500),
  excerpt_en: z.string().min(1).max(500),
  published_at: z.string().optional(),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
});

const putSchema = postSchema.partial().extend({
  id: z.string().uuid(),
});

/**
 * GET — list alle LinkedIn posts (inkl. inactive, sorteret).
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('linkedin_featured_posts')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('published_at', { ascending: false });

  if (error) {
    logger.error('[linkedin-posts] GET fejl:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  return NextResponse.json({ posts: data ?? [] });
}

/**
 * POST — opret ny LinkedIn post.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Valideringsfejl' },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('linkedin_featured_posts')
    .insert([parsed.data])
    .select()
    .single();

  if (error) {
    logger.error('[linkedin-posts] POST fejl:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  return NextResponse.json({ post: data }, { status: 201 });
}

/**
 * PUT — opdater eksisterende LinkedIn post.
 */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Valideringsfejl' },
      { status: 400 }
    );
  }

  const { id, ...updates } = parsed.data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('linkedin_featured_posts')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('[linkedin-posts] PUT fejl:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  return NextResponse.json({ post: data });
}

/**
 * DELETE — slet LinkedIn post.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Ikke autoriseret' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Mangler id' }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { error } = await admin.from('linkedin_featured_posts').delete().eq('id', id);

  if (error) {
    logger.error('[linkedin-posts] DELETE fejl:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
