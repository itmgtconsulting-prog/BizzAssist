/**
 * Domain audit log API — filtered listing + CSV export.
 *
 * BIZZ-718: Admin-only. The audit log is already populated by every
 * write-path in the Domain API (create_case, upload_template, etc.);
 * this endpoint just surfaces it with filters + export.
 *
 * GET /api/domain/:id/audit-log           → JSON list (limit 500)
 * GET /api/domain/:id/audit-log?format=csv → CSV download
 *
 * Filters (query string, all optional):
 *   action     — exact match on audit_log.action
 *   target_type — exact match on target_type
 *   actor       — user_id
 *   since, until — ISO datetime range
 *
 * @module api/domain/[id]/audit-log
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainAdmin } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Escape a value for CSV output — wraps in quotes when the value contains a
 * comma, quote, or newline, and doubles any internal quotes.
 */
function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { id: domainId } = await context.params;
  try {
    await assertDomainAdmin(domainId);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const action = sp.get('action');
  const targetType = sp.get('target_type');
  const actor = sp.get('actor');
  const since = sp.get('since');
  const until = sp.get('until');
  const format = sp.get('format') || 'json';

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (admin as any)
    .from('domain_audit_log')
    .select('id, domain_id, actor_user_id, action, target_type, target_id, metadata, created_at')
    .eq('domain_id', domainId)
    .order('created_at', { ascending: false })
    .limit(format === 'csv' ? 5000 : 500);

  if (action) q = q.eq('action', action);
  if (targetType) q = q.eq('target_type', targetType);
  if (actor) q = q.eq('actor_user_id', actor);
  if (since) q = q.gte('created_at', since);
  if (until) q = q.lte('created_at', until);

  const { data, error } = await q;
  if (error) {
    logger.error('[domain/audit-log] GET error:', error.message);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }

  type AuditRow = {
    id: string;
    domain_id: string;
    actor_user_id: string;
    action: string;
    target_type: string | null;
    target_id: string | null;
    metadata: unknown;
    created_at: string;
  };
  const rows = (data ?? []) as AuditRow[];

  if (format === 'csv') {
    const header = 'id,created_at,actor_user_id,action,target_type,target_id,metadata';
    const body = rows
      .map((r) =>
        [
          r.id,
          r.created_at,
          r.actor_user_id,
          r.action,
          r.target_type ?? '',
          r.target_id ?? '',
          r.metadata,
        ]
          .map(csvEscape)
          .join(',')
      )
      .join('\n');
    const csv = header + '\n' + body;
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="domain-${domainId}-audit.csv"`,
      },
    });
  }

  return NextResponse.json(rows);
}
