/**
 * GET  /api/knowledge          — list all knowledge items for the current tenant
 * POST /api/knowledge          — create a new knowledge item
 * DELETE /api/knowledge?id=N   — delete a knowledge item (admin only)
 *
 * Auth: authenticated user with an active tenant membership required for all verbs.
 * Admin role required for POST and DELETE (write operations).
 *
 * Storage: tenant.tenant_knowledge in the shared "tenant" Supabase schema.
 * Content max: 50 000 characters (enforced here and in the DB CHECK constraint).
 * Title max: 200 characters.
 *
 * Retention: no automatic expiry — content is managed by the tenant admin.
 * GDPR: rows carry tenant_id + created_by for cascade delete on offboarding.
 *
 * @module api/knowledge
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';

/** Maximum characters allowed in a knowledge item's content field. */
const MAX_CONTENT_CHARS = 50_000;

/** Maximum characters allowed in a knowledge item's title field. */
const MAX_TITLE_CHARS = 200;

/** Maximum number of knowledge items returned per tenant. */
const MAX_ITEMS = 50;

// ─── Shared types ────────────────────────────────────────────────────────────

/** A row from tenant.tenant_knowledge as returned by the API. */
export interface KnowledgeItem {
  id: number;
  tenant_id: string;
  title: string;
  content: string;
  source_type: 'manual' | 'upload' | 'url';
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Shape of the POST request body. */
interface CreateKnowledgeBody {
  title: string;
  content: string;
  source_type?: 'manual' | 'upload' | 'url';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the authenticated user's tenant_id and role from the public schema.
 * Returns null if the user is not authenticated or has no tenant membership.
 *
 * @param userId - The authenticated Supabase user UUID
 * @returns Object with tenantId and role, or null
 */
async function resolveTenantMembership(
  userId: string
): Promise<{ tenantId: string; role: string } | null> {
  const adminClient = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (adminClient as any)
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', userId)
    .limit(1)
    .single();

  if (!data?.tenant_id) return null;
  return { tenantId: data.tenant_id as string, role: data.role as string };
}

// ─── GET /api/knowledge ───────────────────────────────────────────────────────

/**
 * Lists all knowledge items for the authenticated user's tenant.
 * Ordered by created_at descending (newest first).
 * Returns at most MAX_ITEMS rows.
 *
 * @param _request - Incoming Next.js request (unused — auth via cookies)
 * @returns JSON array of KnowledgeItem
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(_request, rateLimit);
  if (limited) return limited as unknown as NextResponse;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await resolveTenantMembership(user.id);
  if (!membership) {
    return NextResponse.json({ error: 'Ingen tenant-tilknytning fundet' }, { status: 403 });
  }

  try {
    const adminClient = createAdminClient();

    const { data, error } = await (
      adminClient as unknown as {
        schema: (s: string) => {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (
                col: string,
                val: string
              ) => {
                order: (
                  col: string,
                  opts: { ascending: boolean }
                ) => {
                  limit: (n: number) => Promise<{ data: KnowledgeItem[] | null; error: unknown }>;
                };
              };
            };
          };
        };
      }
    )
      .schema('tenant')
      .from('tenant_knowledge')
      .select('id, tenant_id, title, content, source_type, created_by, created_at, updated_at')
      .eq('tenant_id', membership.tenantId)
      .order('created_at', { ascending: false })
      .limit(MAX_ITEMS);

    if (error) throw error;

    return NextResponse.json(data ?? []);
  } catch (err) {
    console.error('[knowledge] GET fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

// ─── POST /api/knowledge ──────────────────────────────────────────────────────

/**
 * Creates a new knowledge item for the authenticated user's tenant.
 * Requires tenant_admin role.
 * Content is truncated server-side to MAX_CONTENT_CHARS even if the DB
 * CHECK would also catch it — this gives a cleaner user-facing error.
 *
 * @param request - Incoming Next.js request with JSON body { title, content, source_type? }
 * @returns JSON KnowledgeItem of the newly created row
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as unknown as NextResponse;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await resolveTenantMembership(user.id);
  if (!membership) {
    return NextResponse.json({ error: 'Ingen tenant-tilknytning fundet' }, { status: 403 });
  }

  // Admin-only write
  if (membership.role !== 'tenant_admin') {
    return NextResponse.json(
      { error: 'Kun tenant-administratorer kan oprette videnbase-elementer' },
      { status: 403 }
    );
  }

  let body: CreateKnowledgeBody;
  try {
    body = (await request.json()) as CreateKnowledgeBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { title, content, source_type = 'manual' } = body;

  // Validate title
  if (typeof title !== 'string' || title.trim().length === 0) {
    return NextResponse.json({ error: 'title er påkrævet' }, { status: 400 });
  }
  if (title.length > MAX_TITLE_CHARS) {
    return NextResponse.json(
      { error: `title må maks være ${MAX_TITLE_CHARS} tegn` },
      { status: 400 }
    );
  }

  // Validate content
  if (typeof content !== 'string' || content.trim().length === 0) {
    return NextResponse.json({ error: 'content er påkrævet' }, { status: 400 });
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return NextResponse.json(
      { error: `content må maks være ${MAX_CONTENT_CHARS} tegn` },
      { status: 400 }
    );
  }

  // Validate source_type
  const validSourceTypes = ['manual', 'upload', 'url'] as const;
  if (!validSourceTypes.includes(source_type as (typeof validSourceTypes)[number])) {
    return NextResponse.json(
      { error: `source_type skal være: ${validSourceTypes.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const adminClient = createAdminClient();

    const { data, error } = await (
      adminClient as unknown as {
        schema: (s: string) => {
          from: (t: string) => {
            insert: (row: Record<string, unknown>) => {
              select: (cols: string) => {
                single: () => Promise<{ data: KnowledgeItem | null; error: unknown }>;
              };
            };
          };
        };
      }
    )
      .schema('tenant')
      .from('tenant_knowledge')
      .insert({
        tenant_id: membership.tenantId,
        title: title.trim(),
        content: content.trim(),
        source_type,
        created_by: user.id,
      })
      .select('id, tenant_id, title, content, source_type, created_by, created_at, updated_at')
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error('[knowledge] POST fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

// ─── DELETE /api/knowledge?id=N ──────────────────────────────────────────────

/**
 * Deletes a knowledge item by id.
 * Requires tenant_admin role. The item must belong to the caller's tenant.
 *
 * @param request - Incoming Next.js request with ?id= query param
 * @returns 204 No Content on success
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as unknown as NextResponse;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await resolveTenantMembership(user.id);
  if (!membership) {
    return NextResponse.json({ error: 'Ingen tenant-tilknytning fundet' }, { status: 403 });
  }

  if (membership.role !== 'tenant_admin') {
    return NextResponse.json(
      { error: 'Kun tenant-administratorer kan slette videnbase-elementer' },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const idStr = searchParams.get('id');
  const id = idStr ? parseInt(idStr, 10) : NaN;

  if (isNaN(id) || id <= 0) {
    return NextResponse.json({ error: 'Ugyldig id-parameter' }, { status: 400 });
  }

  try {
    const adminClient = createAdminClient();

    const { error } = await (
      adminClient as unknown as {
        schema: (s: string) => {
          from: (t: string) => {
            delete: () => {
              eq: (
                col: string,
                val: string
              ) => {
                eq: (col: string, val: number) => Promise<{ error: unknown }>;
              };
            };
          };
        };
      }
    )
      .schema('tenant')
      .from('tenant_knowledge')
      .delete()
      .eq('tenant_id', membership.tenantId)
      .eq('id', id);

    if (error) throw error;

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[knowledge] DELETE fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
