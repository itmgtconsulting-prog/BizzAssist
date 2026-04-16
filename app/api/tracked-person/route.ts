/**
 * Tracked persons API — /api/tracked-person
 *
 * Håndterer CRUD for fulgte personer via Supabase saved_entities
 * med entity_type='person' og is_monitored=true.
 *
 * GDPR: Gemmer KUN enhedsNummer som entity_id — ingen PII (navn, CPR) lagres.
 *
 * GET    /api/tracked-person                          — hent alle fulgte
 * POST   /api/tracked-person { enhedsNummer }         — start følgning
 * DELETE /api/tracked-person?enhedsNummer=<number>    — stop følgning
 *
 * @module api/tracked-person
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { getTenantContext } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';

/** Zod schema for POST body */
const postSchema = z.object({
  enhedsNummer: z.string().regex(/^\d+$/, 'enhedsNummer skal være numerisk'),
});

/**
 * GET /api/tracked-person — hent alle fulgte personer
 *
 * @returns { persons: Array<{ enhedsNummer: string; trackedSince: string }> }
 */
export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ persons: [] });

  try {
    const ctx = await getTenantContext(auth.tenantId);
    const entities = await ctx.savedEntities.list({
      entity_type: 'person',
      monitored_only: true,
    });

    return NextResponse.json({
      persons: (entities ?? []).map((e: { entity_id: string; created_at?: string }) => ({
        enhedsNummer: e.entity_id,
        trackedSince: e.created_at ?? '',
      })),
    });
  } catch (err) {
    logger.error('[tracked-person] GET error:', err);
    return NextResponse.json({ persons: [] });
  }
}

/**
 * POST /api/tracked-person — start følgning af person
 *
 * @param body.enhedsNummer - Person enhedsNummer (kun numerisk ID — ingen PII)
 */
export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
    }

    const { enhedsNummer } = parsed.data;
    const ctx = await getTenantContext(auth.tenantId);

    await ctx.savedEntities.upsert({
      entity_type: 'person',
      entity_id: enhedsNummer,
      label: `Person ${enhedsNummer}`, // No PII — only enhedsNummer
      entity_data: {},
      is_monitored: true,
      created_by: auth.userId,
    });

    void writeAuditLog({
      action: 'person_tracked',
      resource_type: 'person',
      resource_id: enhedsNummer,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[tracked-person] POST error:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}

/**
 * DELETE /api/tracked-person?enhedsNummer=123 — stop følgning
 */
export async function DELETE(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const enhedsNummer = request.nextUrl.searchParams.get('enhedsNummer');
    if (!enhedsNummer || !/^\d+$/.test(enhedsNummer)) {
      return NextResponse.json({ error: 'enhedsNummer mangler' }, { status: 400 });
    }

    const ctx = await getTenantContext(auth.tenantId);
    // Set is_monitored=false (same pattern as /api/tracked DELETE)
    await ctx.savedEntities.upsert({
      entity_type: 'person',
      entity_id: enhedsNummer,
      label: `Person ${enhedsNummer}`,
      entity_data: {},
      is_monitored: false,
      created_by: auth.userId,
    });

    void writeAuditLog({
      action: 'person_untracked',
      resource_type: 'person',
      resource_id: enhedsNummer,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[tracked-person] DELETE error:', err);
    return NextResponse.json({ error: 'Intern serverfejl' }, { status: 500 });
  }
}
