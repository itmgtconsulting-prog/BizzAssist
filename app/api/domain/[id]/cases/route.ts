/**
 * Domain Cases API — list + create cases for a single domain.
 *
 * BIZZ-712: Member-scoped (not admin-only) — any domain member can see and
 * create cases. All writes are audit-logged to domain_audit_log.
 *
 * GET  /api/domain/:id/cases?status=open&search=&limit=  — list cases
 * POST /api/domain/:id/cases — create case (body: { name, client_ref?, tags? })
 *
 * @module api/domain/[id]/cases
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET — list cases in the domain. Supports ?status= (open|closed|archived|all)
 * and ?search= (case-insensitive substring on name + client_ref). Defaults:
 * status=open, limit=100.
 */
export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId } = await context.params;
  try {
    await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const statusParam = request.nextUrl.searchParams.get('status') || 'open';
  const search = request.nextUrl.searchParams.get('search')?.trim() || '';
  const limit = Math.min(
    Math.max(parseInt(request.nextUrl.searchParams.get('limit') || '100', 10) || 100, 1),
    500
  );

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (admin as any)
    .from('domain_case')
    .select(
      // BIZZ-809: short_description inkluderes i list-responset til preview
      // på sagskort (max 200 tegn, null hvis ikke sat).
      'id, name, client_ref, status, tags, short_description, created_by, created_at, updated_at'
    )
    .eq('domain_id', domainId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (statusParam !== 'all') {
    q = q.eq('status', statusParam);
  }
  if (search) {
    // Escape % and _ so they're literal, then wrap in %…%
    const escaped = search.replace(/[%_]/g, (c) => `\\${c}`);
    q = q.or(`name.ilike.%${escaped}%,client_ref.ilike.%${escaped}%`);
  }

  const { data, error } = await q;
  if (error) {
    logger.error('[domain/cases] GET error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

/**
 * POST — create a new case.
 * Body: { name: string (1-200 chars), client_ref?: string, tags?: string[] }
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: domainId } = await context.params;
  let ctx;
  try {
    ctx = await assertDomainMember(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const clientRef = typeof body.client_ref === 'string' ? body.client_ref.trim() : null;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string').slice(0, 20)
    : [];
  if (!name || name.length > 200) {
    return NextResponse.json({ error: 'name is required (1-200 chars)' }, { status: 400 });
  }
  // BIZZ-809: short_description valgfri, max 200 tegn. Null ved manglende
  // eller tom streng.
  const shortDescription =
    typeof body.short_description === 'string' && body.short_description.trim()
      ? body.short_description.trim().slice(0, 200)
      : null;

  // BIZZ-802: Optional structured customer link. Validate kind+id pairing
  // — if kind='company' a CVR must be present; if 'person' a person_id.
  const clientKind =
    body.client_kind === 'company' || body.client_kind === 'person' ? body.client_kind : null;
  const clientCvr =
    clientKind === 'company' && typeof body.client_cvr === 'string' && body.client_cvr.trim()
      ? body.client_cvr.trim()
      : null;
  const clientPersonId =
    clientKind === 'person' &&
    typeof body.client_person_id === 'string' &&
    body.client_person_id.trim()
      ? body.client_person_id.trim()
      : null;
  const clientName =
    clientKind && typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().slice(0, 200)
      : null;
  if (clientKind === 'company' && !clientCvr) {
    return NextResponse.json(
      { error: 'client_cvr is required when client_kind=company' },
      { status: 400 }
    );
  }
  if (clientKind === 'person' && !clientPersonId) {
    return NextResponse.json(
      { error: 'client_person_id is required when client_kind=person' },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = (await (admin as any)
    .from('domain_case')
    .insert({
      domain_id: domainId,
      name,
      client_ref: clientRef,
      tags,
      created_by: ctx.userId,
      client_kind: clientKind,
      client_cvr: clientCvr,
      client_person_id: clientPersonId,
      client_name: clientName,
      short_description: shortDescription,
    })
    .select(
      'id, name, client_ref, status, tags, short_description, created_at, client_kind, client_cvr, client_person_id, client_name'
    )
    .single()) as { data: { id: string } | null; error: { message: string } | null };

  if (error || !data) {
    logger.error('[domain/cases] POST error:', error?.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  // Audit log
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('domain_audit_log').insert({
    domain_id: domainId,
    actor_user_id: ctx.userId,
    action: 'create_case',
    target_type: 'case',
    target_id: data.id,
    metadata: {
      name,
      client_ref: clientRef,
      tags,
      client_kind: clientKind,
      client_cvr: clientCvr,
      client_person_id: clientPersonId,
    },
  });

  return NextResponse.json(data, { status: 201 });
}
