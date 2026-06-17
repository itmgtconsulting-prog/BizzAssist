/**
 * POST /api/forsikring/standard-docs/auto-match
 *
 * BIZZ-2137: Auto-vælg standard betingelser fra biblioteket ved analyse-start.
 * Givet et sæt dokument-ID'er (de valgte policer i analyse-wizarden) finder
 * endpointet de standardbetingelses-referencer (conditions_ref) som policernes
 * dækninger refererer til, og matcher dem mod forsikring_standard_doc.titel.
 * Matchende biblioteks-dokumenter returneres, så frontend kan pre-selecte dem i
 * stdSelectedIds — uafhængigt af kundens historik (BIZZ-2078 dækker historik).
 *
 * Body: { document_ids: string[] }
 * Returns: { matched: Array<{ source_url: string; titel: string; ref: string }> }
 *
 * GDPR: Læser kun policer/dækninger i tenantens eget skema; ingen PII gemmes
 * eller logges. Ingen retention — read-only opslag.
 *
 * @module app/api/forsikring/standard-docs/auto-match/route
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { getTenantSchemaName } from '@/lib/db/tenant';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * Session-client der respekterer RLS visibility-scoping på standard-docs.
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

/**
 * Rens og split en rå conditions_ref-streng til enkelt-referencer.
 *
 * @param raw - conditions_ref fra en dækning (kan indeholde flere refs)
 * @returns Liste af rensede referencer (fx ["DF20900-2", "DF20903-2"])
 */
function extractRefs(raw: string): string[] {
  const out: string[] = [];
  for (let ref of raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    ref = ref.replace(/^(se\s+)?(betingelses)?afsnit\s*/i, '').trim();
    if (!ref || /^se\s+vilk/i.test(ref) || ref.length < 2) continue;
    out.push(ref);
  }
  return out;
}

/**
 * POST handler — matcher policernes conditions_ref mod biblioteket.
 *
 * @param request - { document_ids: string[] }
 * @returns { matched: [{ source_url, titel, ref }] }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { document_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const documentIds = Array.isArray(body.document_ids)
    ? body.document_ids.filter((d): d is string => typeof d === 'string')
    : [];
  if (documentIds.length === 0) {
    return NextResponse.json({ matched: [] });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return NextResponse.json({ matched: [] });
  }

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) {
      return NextResponse.json({ matched: [] });
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tenantDb = (admin as any).schema(schemaName);

    // 1. Policer for de valgte dokumenter
    const { data: polRows } = await tenantDb
      .from('forsikring_policies')
      .select('id')
      .in('document_id', documentIds)
      .eq('tenant_id', auth.tenantId);
    const policyIds = ((polRows ?? []) as Array<{ id: string }>).map((p) => p.id);
    if (policyIds.length === 0) {
      return NextResponse.json({ matched: [] });
    }

    // 2. conditions_ref fra policernes dækninger
    const { data: covRows } = await tenantDb
      .from('forsikring_coverages')
      .select('conditions_ref')
      .in('policy_id', policyIds)
      .eq('tenant_id', auth.tenantId)
      .not('conditions_ref', 'is', null);

    const refs = new Set<string>();
    for (const cov of (covRows ?? []) as Array<{ conditions_ref: string | null }>) {
      if (!cov.conditions_ref) continue;
      for (const ref of extractRefs(cov.conditions_ref)) refs.add(ref);
    }
    if (refs.size === 0) {
      return NextResponse.json({ matched: [] });
    }

    // 3. Match mod biblioteket — kun docs brugeren må se (RLS visibility)
    const sessionClient = await getSessionClient();
    const { data: stdDocs } = await sessionClient
      .from('forsikring_standard_doc')
      .select('titel, source_url')
      .limit(300);

    const matched: Array<{ source_url: string; titel: string; ref: string }> = [];
    const seen = new Set<string>();
    for (const doc of (stdDocs ?? []) as Array<{ titel: string; source_url: string }>) {
      const titelLower = (doc.titel ?? '').toLowerCase();
      if (!titelLower) continue;
      for (const ref of refs) {
        if (titelLower.includes(ref.toLowerCase())) {
          if (!seen.has(doc.source_url)) {
            seen.add(doc.source_url);
            matched.push({ source_url: doc.source_url, titel: doc.titel, ref });
          }
          break;
        }
      }
    }

    return NextResponse.json({ matched });
  } catch (err) {
    logger.error('[standard-docs/auto-match]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
