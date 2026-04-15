/**
 * LinkedIn profile enrichment — BIZZ-48
 *
 * POST /api/integrations/linkedin/enrich
 * Attempts to enrich a CVR person with LinkedIn profile data.
 *
 * Body: { enhedsNummer: string }
 *
 * IMPORTANT — Partner Program Required:
 * LinkedIn's people search API (People Search v2, Recruiter APIs) requires
 * acceptance into the LinkedIn Partner Program before access is granted.
 * Standard OAuth apps cannot search for members by name or other attributes.
 *
 * Until Partner Program access is approved, this endpoint returns a stub
 * response with a manual search link and instructions to apply.
 *
 * Apply here: https://developer.linkedin.com/partner-programs/search
 *
 * @see https://learn.microsoft.com/en-us/linkedin/shared/references/v2/search/
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveTenantId } from '@/lib/api/auth';
import { tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/integrations/linkedin/enrich request body */
const linkedinEnrichSchema = z
  .object({
    enhedsNummer: z.string().min(1),
    personName: z.string().optional(),
  })
  .passthrough();

/** Request body for the enrich endpoint */
interface EnrichRequest {
  /** CVR person enhedsNummer to look up */
  enhedsNummer: string;
  /** Full name of the person (used to build LinkedIn search URL) */
  personName?: string;
}

/** Response when LinkedIn enrichment is not yet available */
interface EnrichUnavailableResponse {
  available: false;
  message: string;
  /** Direct LinkedIn people search URL for manual lookup */
  linkedinSearchUrl: string;
  /** LinkedIn Partner Program application page */
  partnerProgramUrl: string;
}

/** Validates that the parsed body matches EnrichRequest */
function _isEnrichRequest(value: unknown): value is EnrichRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'enhedsNummer' in value &&
    typeof (value as Record<string, unknown>).enhedsNummer === 'string'
  );
}

/**
 * POST /api/integrations/linkedin/enrich
 * Returns LinkedIn enrichment data for a CVR person identified by enhedsNummer.
 *
 * Currently a stub — LinkedIn Partner Program approval is required for
 * people search API access. Returns a not-available response with a manual
 * LinkedIn search URL so users can look up profiles themselves.
 *
 * @param request - Next.js request with JSON body { enhedsNummer, personName? }
 * @returns EnrichUnavailableResponse until Partner Program is approved
 */
export async function POST(
  request: NextRequest
): Promise<NextResponse<EnrichUnavailableResponse | { error: string }>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<EnrichUnavailableResponse | { error: string }>;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });

  // Parse and validate request body
  const parsed = await parseBody(request, linkedinEnrichSchema);
  if (!parsed.success)
    return parsed.response as NextResponse<EnrichUnavailableResponse | { error: string }>;
  const body = parsed.data;

  const { tenantId, userId } = auth;
  // Verify user has LinkedIn connected
  const { data: integration } = await tenantDb(tenantId)
    .from('email_integrations')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', 'linkedin')
    .maybeSingle();

  if (!integration) {
    return NextResponse.json(
      { error: 'LinkedIn er ikke forbundet. Forbind din LinkedIn-konto under Indstillinger.' },
      { status: 403 }
    );
  }

  // ── Temporary stub until LinkedIn Partner Program is approved ─────────────
  // LinkedIn's people search API requires Partner Program membership.
  // Standard OAuth apps receive 403 on /v2/search/blended and similar endpoints.
  // The search URL below lets users manually search LinkedIn with the person's name.
  const personName = body.personName ?? '';
  const linkedinSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(personName)}`;

  return NextResponse.json({
    available: false,
    message:
      'LinkedIn profil-berigelse kræver LinkedIn Partner Program adgang. Søg manuelt via LinkedIn.',
    linkedinSearchUrl,
    partnerProgramUrl: 'https://developer.linkedin.com/partner-programs/search',
  });
}
