/**
 * GET   /api/knowledge/[id]   — fetch a single knowledge item by primary key
 * PATCH /api/knowledge/[id]   — update title, content, or source_type (admin only)
 *
 * Auth: authenticated user with active tenant membership required.
 * Admin role required for PATCH.
 * The item must belong to the caller's tenant — cross-tenant access is blocked
 * both by the RLS policy on tenant.tenant_knowledge and by the explicit
 * tenant_id filter in application code.
 *
 * @module api/knowledge/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
/** Maximum characters allowed in a knowledge item's content field. */
const MAX_CONTENT_CHARS = 50_000;

/** Maximum characters allowed in a knowledge item's title field. */
const MAX_TITLE_CHARS = 200;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolves the authenticated user's tenant_id and role from the public schema.
 *
 * @param userId - Authenticated Supabase user UUID
 * @returns Object with tenantId and role, or null if not found
 */
async function resolveTenantMembership(
  userId: string
): Promise<{ tenantId: string; role: string } | null> {
  const adminClient = createAdminClient();

  const { data } = await adminClient
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', userId)
    .limit(1)
    .single();

  if (!data?.tenant_id) return null;
  return { tenantId: data.tenant_id as string, role: data.role as string };
}

// ─── Route params type ────────────────────────────────────────────────────────

interface RouteParams {
  params: Promise<{ id: string }>;
}

// ─── GET /api/knowledge/[id] ─────────────────────────────────────────────────

/**
 * Returns a single knowledge item by its primary key.
 * The item must belong to the caller's tenant.
 *
 * @param request - Incoming Next.js request
 * @param params  - Route params containing the knowledge item id
 * @returns JSON KnowledgeItem or 404
 */
export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
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

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id <= 0) {
    return NextResponse.json({ error: 'Ugyldig id' }, { status: 400 });
  }

  try {
    const { data, error } = await tenantDb(membership.tenantId)
      .from('tenant_knowledge')
      .select('id, tenant_id, title, content, source_type, created_by, created_at, updated_at')
      .eq('tenant_id', membership.tenantId)
      .eq('id', id)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Videnbase-element ikke fundet' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('[knowledge/[id]] GET fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}

// ─── PATCH /api/knowledge/[id] ───────────────────────────────────────────────

/** Partial update body — all fields are optional */
interface PatchKnowledgeBody {
  title?: string;
  content?: string;
  source_type?: 'manual' | 'upload' | 'url';
}

/**
 * Partially updates a knowledge item's title, content, or source_type.
 * Requires tenant_admin role.
 * Only the fields present in the request body are updated.
 *
 * @param request - Incoming Next.js request with partial JSON body
 * @param params  - Route params containing the knowledge item id
 * @returns JSON KnowledgeItem with updated values
 */
export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
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
      { error: 'Kun tenant-administratorer kan redigere videnbase-elementer' },
      { status: 403 }
    );
  }

  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id) || id <= 0) {
    return NextResponse.json({ error: 'Ugyldig id' }, { status: 400 });
  }

  let body: PatchKnowledgeBody;
  try {
    body = (await request.json()) as PatchKnowledgeBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  // Build the update patch — only include defined fields
  const patch: Record<string, string> = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return NextResponse.json({ error: 'title må ikke være tom' }, { status: 400 });
    }
    if (body.title.length > MAX_TITLE_CHARS) {
      return NextResponse.json(
        { error: `title må maks være ${MAX_TITLE_CHARS} tegn` },
        { status: 400 }
      );
    }
    patch.title = body.title.trim();
  }

  if (body.content !== undefined) {
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return NextResponse.json({ error: 'content må ikke være tom' }, { status: 400 });
    }
    if (body.content.length > MAX_CONTENT_CHARS) {
      return NextResponse.json(
        { error: `content må maks være ${MAX_CONTENT_CHARS} tegn` },
        { status: 400 }
      );
    }
    patch.content = body.content.trim();
  }

  if (body.source_type !== undefined) {
    const validSourceTypes = ['manual', 'upload', 'url'] as const;
    if (!validSourceTypes.includes(body.source_type as (typeof validSourceTypes)[number])) {
      return NextResponse.json(
        { error: `source_type skal være: ${validSourceTypes.join(', ')}` },
        { status: 400 }
      );
    }
    patch.source_type = body.source_type;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Ingen felter at opdatere' }, { status: 400 });
  }

  try {
    const { data, error } = await tenantDb(membership.tenantId)
      .from('tenant_knowledge')
      .update(patch)
      .eq('tenant_id', membership.tenantId)
      .eq('id', id)
      .select('id, tenant_id, title, content, source_type, created_by, created_at, updated_at')
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Videnbase-element ikke fundet' }, { status: 404 });
    }

    // Audit log — fire-and-forget (ISO 27001 A.12.4)
    createAdminClient()
      .from('audit_log')
      .insert({
        action: 'knowledge.update',
        resource_type: 'knowledge_item',
        resource_id: String(id),
        metadata: JSON.stringify({
          tenantId: membership.tenantId,
          updatedFields: Object.keys(patch),
          userId: user.id,
        }),
      })
      .then()
      .catch(() => {});

    return NextResponse.json(data);
  } catch (err) {
    console.error('[knowledge/[id]] PATCH fejlede:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
