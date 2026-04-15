/**
 * GDPR Consent Tracking API — /api/consent
 *
 * Records cookie consent decisions to public.consent_log for GDPR Article 7(1)
 * accountability. Called by CookieBanner when user accepts or declines cookies.
 *
 * POST /api/consent — record a consent decision
 *   Body: { consent: 'accepted' | 'declined', categories?: string[] }
 *
 * GET /api/consent — get current consent status for authenticated user
 *
 * BIZZ-275: Backend consent tracking to complement client-side cookie storage.
 *
 * @module api/consent
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '@/app/lib/validate';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import crypto from 'node:crypto';

/** Zod schema for consent body */
const consentSchema = z.object({
  consent: z.enum(['accepted', 'declined']),
  categories: z.array(z.string()).optional().default(['necessary']),
});

/**
 * Hash IP address for privacy — store hash, not raw IP.
 * Uses SHA-256 with a static salt to prevent rainbow table attacks
 * while still allowing duplicate detection.
 */
function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(`bizzassist-consent:${ip}`).digest('hex').slice(0, 16);
}

/**
 * POST /api/consent
 * Records a consent decision. Works for both authenticated and anonymous users.
 *
 * @param request - JSON body with consent value and optional categories
 * @returns { ok: true } on success
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const parsed = await parseBody(request, consentSchema);
  if (!parsed.success) return parsed.response;

  const { consent, categories } = parsed.data;

  // Get user ID if authenticated (consent works for anonymous too)
  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    // Anonymous consent — that's fine
  }

  // Hash IP for privacy (never store raw IP — ISO 27001 + GDPR)
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? 'unknown';
  const ipHash = hashIp(ip);

  const userAgent = request.headers.get('user-agent')?.slice(0, 200) ?? null;

  try {
    const admin = createAdminClient();
    await (
      admin as unknown as {
        from: (t: string) => {
          insert: (v: Record<string, unknown>) => Promise<{ error: unknown }>;
        };
      }
    )
      .from('consent_log')
      .insert({
        user_id: userId,
        session_id: ipHash,
        consent_value: consent,
        categories: JSON.stringify(categories),
        ip_hash: ipHash,
        user_agent: userAgent,
      });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[consent] Failed to log consent:', err);
    // Non-fatal — consent still stored in cookie by the client
    return NextResponse.json({ ok: true });
  }
}

/**
 * GET /api/consent
 * Returns the most recent consent record for the authenticated user.
 *
 * @returns Latest consent record or null
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ consent: null });
    }

    const admin = createAdminClient();
    // consent_log is not in generated Supabase types — use untyped query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('consent_log')
      .select('consent_value, categories, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return NextResponse.json({
      consent: data?.consent_value ?? null,
      categories: data?.categories ?? null,
      recordedAt: data?.created_at ?? null,
    });
  } catch {
    return NextResponse.json({ consent: null });
  }
}
