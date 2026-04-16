/**
 * GET /api/adresse/autocomplete?q=...
 *
 * Server-side proxy for DAR autocomplete.
 * Nødvendig fordi DAR kræver API-nøgle (server-side env var),
 * mens autocomplete bruges fra client-side komponenter.
 *
 * Logs 'address_search' events to activity_log for usage analytics.
 * Payload: { queryLength } — no raw query string stored (avoids PII risk).
 *
 * @param request - Next.js request med ?q=søgestreng
 * @returns Array af DawaAutocompleteResult (DAR-kompatibelt format)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { darAutocomplete } from '@/app/lib/dar';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { logActivity } from '@/app/lib/activityLog';
import { logger } from '@/app/lib/logger';
import { parseQuery } from '@/app/lib/validate';

/** Zod schema for autocomplete query params */
const autocompleteSchema = z.object({
  q: z.string().default(''),
});

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const parsed = parseQuery(request, autocompleteSchema);
  if (!parsed.success) return parsed.response;
  const { q } = parsed.data;

  if (q.trim().length < 2) {
    return NextResponse.json([]);
  }

  // Resolve auth context for activity logging — non-blocking if unauthenticated
  // (autocomplete is also called during login flow, so we don't gate on auth here)
  const auth = await resolveTenantId();
  if (auth) {
    logActivity(createAdminClient(), auth.tenantId, auth.userId, 'address_search', {
      // Store query length only — raw query string is omitted to avoid PII risk
      queryLength: q.trim().length,
    });
  }

  try {
    const results = await darAutocomplete(q);
    return NextResponse.json(results, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (err) {
    logger.error('[adresse/autocomplete] Fejl:', err);
    return NextResponse.json([], { status: 200 });
  }
}
