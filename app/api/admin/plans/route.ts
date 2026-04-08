/**
 * Admin plan configuration API — /api/admin/plans
 *
 * GET  — fetch all plan configs from DB (with hardcoded fallbacks for legacy plans)
 * POST — create, update, or delete plans
 *
 * Only accessible by admin user.
 *
 * @see app/lib/subscriptions.ts — PlanDef interface and PLANS defaults
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { PLANS, type PlanId } from '@/app/lib/subscriptions';

const LEGACY_PLAN_IDS: PlanId[] = ['demo', 'basis', 'professionel', 'enterprise'];

/** Row shape from plan_configs table. */
interface PlanConfigRow {
  plan_id: string;
  name_da: string;
  name_en: string;
  desc_da: string;
  desc_en: string;
  color: string;
  price_dkk: number;
  ai_tokens_per_month: number;
  duration_months: number;
  duration_days: number;
  token_accumulation_cap_multiplier: number;
  ai_enabled: boolean;
  requires_approval: boolean;
  is_active: boolean;
  free_trial_days: number;
  stripe_price_id: string | null;
  max_sales: number | null;
  sales_count: number;
  sort_order: number;
  updated_at: string;
}

/** Verify caller is admin (app_metadata.isAdmin). */
async function verifyAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (freshUser?.user?.app_metadata?.isAdmin) return user;
  return null;
}

/** Map a DB row to the frontend plan shape. */
function mapRow(row: PlanConfigRow, defaults?: (typeof PLANS)[PlanId]) {
  return {
    id: row.plan_id,
    nameDa: row.name_da || defaults?.nameDa || row.plan_id,
    nameEn: row.name_en || defaults?.nameEn || row.plan_id,
    descDa: row.desc_da || defaults?.descDa || '',
    descEn: row.desc_en || defaults?.descEn || '',
    color: row.color || defaults?.color || 'blue',
    priceDkk: row.price_dkk,
    aiTokensPerMonth: row.ai_tokens_per_month,
    durationMonths: row.duration_months,
    durationDays: row.duration_days,
    tokenAccumulationCapMultiplier: row.token_accumulation_cap_multiplier,
    aiEnabled: row.ai_enabled,
    requiresApproval: row.requires_approval,
    isActive: row.is_active,
    freeTrialDays: row.free_trial_days,
    stripePriceId: row.stripe_price_id ?? '',
    maxSales: row.max_sales ?? null,
    salesCount: row.sales_count ?? 0,
    sortOrder: row.sort_order ?? 0,
    updatedAt: row.updated_at ?? '',
  };
}

/**
 * GET /api/admin/plans — fetch all plan configs from DB.
 * Falls back to hardcoded defaults for legacy plans not yet in DB.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await verifyAdmin();
    if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const admin = createAdminClient();
    const { data, error } = (await admin
      .from('plan_configs')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('plan_id')) as {
      data: PlanConfigRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      console.error('[admin/plans GET] DB error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const dbMap = new Map<string, PlanConfigRow>();
    for (const row of data ?? []) {
      dbMap.set(row.plan_id, row);
    }

    // Start with DB rows mapped
    const plans = (data ?? []).map((row) => {
      const defaults = LEGACY_PLAN_IDS.includes(row.plan_id as PlanId)
        ? PLANS[row.plan_id as PlanId]
        : undefined;
      return mapRow(row, defaults);
    });

    // Add any legacy plans missing from DB
    for (const id of LEGACY_PLAN_IDS) {
      if (!dbMap.has(id)) {
        const d = PLANS[id];
        plans.push({
          id,
          nameDa: d.nameDa,
          nameEn: d.nameEn,
          descDa: d.descDa,
          descEn: d.descEn,
          color: d.color,
          priceDkk: d.priceDkk,
          aiTokensPerMonth: d.aiTokensPerMonth,
          durationMonths: d.durationMonths,
          durationDays: 0,
          tokenAccumulationCapMultiplier: d.tokenAccumulationCapMultiplier,
          aiEnabled: d.aiEnabled,
          requiresApproval: d.requiresApproval,
          isActive: true,
          freeTrialDays: 0,
          stripePriceId: '',
          maxSales: null,
          salesCount: 0,
          sortOrder: LEGACY_PLAN_IDS.indexOf(id) + 1,
          updatedAt: '',
        });
      }
    }

    return NextResponse.json(plans);
  } catch (err) {
    console.error('[admin/plans] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/plans — create, update, or delete a plan.
 *
 * Body: { action: 'create' | 'update' | 'delete', planId, ...fields }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await verifyAdmin();
    if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json();
    const { action, planId, ...updates } = body;
    const admin = createAdminClient();

    switch (action) {
      case 'create': {
        if (!planId) return NextResponse.json({ error: 'planId required' }, { status: 400 });
        const row = {
          plan_id: planId,
          name_da: updates.nameDa ?? planId,
          name_en: updates.nameEn ?? planId,
          desc_da: updates.descDa ?? '',
          desc_en: updates.descEn ?? '',
          color: updates.color ?? 'blue',
          price_dkk: updates.priceDkk ?? 0,
          ai_tokens_per_month: updates.aiTokensPerMonth ?? 0,
          duration_months: updates.durationMonths ?? 1,
          duration_days: updates.durationDays ?? 0,
          token_accumulation_cap_multiplier: updates.tokenAccumulationCapMultiplier ?? 5,
          ai_enabled: updates.aiEnabled ?? false,
          requires_approval: updates.requiresApproval ?? false,
          is_active: updates.isActive ?? true,
          free_trial_days: updates.freeTrialDays ?? 0,
          max_sales: updates.maxSales ?? null,
          sales_count: updates.salesCount ?? 0,
          sort_order: updates.sortOrder ?? 99,
          updated_at: new Date().toISOString(),
          updated_by: user.id,
        };
        const { error } = await admin.from('plan_configs').insert(row as never);
        if (error) {
          console.error('[admin/plans create] DB error:', error.message);
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }
        return NextResponse.json({ ok: true });
      }

      case 'delete': {
        if (!planId) return NextResponse.json({ error: 'planId required' }, { status: 400 });
        const { error } = await admin.from('plan_configs').delete().eq('plan_id', planId);
        if (error) {
          console.error('[admin/plans delete] DB error:', error.message);
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }
        return NextResponse.json({ ok: true });
      }

      default: {
        // Default = update (backwards compatible)
        if (!planId) return NextResponse.json({ error: 'planId required' }, { status: 400 });

        const updateFields: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
          updated_by: user.id,
        };
        if (updates.nameDa !== undefined) updateFields.name_da = updates.nameDa;
        if (updates.nameEn !== undefined) updateFields.name_en = updates.nameEn;
        if (updates.descDa !== undefined) updateFields.desc_da = updates.descDa;
        if (updates.descEn !== undefined) updateFields.desc_en = updates.descEn;
        if (updates.color !== undefined) updateFields.color = updates.color;
        if (updates.priceDkk !== undefined) updateFields.price_dkk = updates.priceDkk;
        if (updates.aiTokensPerMonth !== undefined)
          updateFields.ai_tokens_per_month = updates.aiTokensPerMonth;
        if (updates.durationMonths !== undefined)
          updateFields.duration_months = updates.durationMonths;
        if (updates.durationDays !== undefined) updateFields.duration_days = updates.durationDays;
        if (updates.tokenAccumulationCapMultiplier !== undefined)
          updateFields.token_accumulation_cap_multiplier = updates.tokenAccumulationCapMultiplier;
        if (updates.aiEnabled !== undefined) updateFields.ai_enabled = updates.aiEnabled;
        if (updates.requiresApproval !== undefined)
          updateFields.requires_approval = updates.requiresApproval;
        if (updates.isActive !== undefined) updateFields.is_active = updates.isActive;
        if (updates.freeTrialDays !== undefined)
          updateFields.free_trial_days = updates.freeTrialDays;
        if (updates.stripePriceId !== undefined)
          updateFields.stripe_price_id = updates.stripePriceId;
        if (updates.maxSales !== undefined) updateFields.max_sales = updates.maxSales;
        if (updates.salesCount !== undefined) updateFields.sales_count = updates.salesCount;
        if (updates.sortOrder !== undefined) updateFields.sort_order = updates.sortOrder;

        // Use upsert to handle both existing and new-to-DB plans
        const defaults = LEGACY_PLAN_IDS.includes(planId as PlanId)
          ? PLANS[planId as PlanId]
          : null;
        const { error } = await admin.from('plan_configs').upsert(
          {
            plan_id: planId,
            name_da: updates.nameDa ?? defaults?.nameDa ?? planId,
            name_en: updates.nameEn ?? defaults?.nameEn ?? planId,
            desc_da: updates.descDa ?? defaults?.descDa ?? '',
            desc_en: updates.descEn ?? defaults?.descEn ?? '',
            color: updates.color ?? defaults?.color ?? 'blue',
            price_dkk: updates.priceDkk ?? defaults?.priceDkk ?? 0,
            ai_tokens_per_month: updates.aiTokensPerMonth ?? defaults?.aiTokensPerMonth ?? 0,
            duration_months: updates.durationMonths ?? defaults?.durationMonths ?? 1,
            duration_days: updates.durationDays ?? 0,
            token_accumulation_cap_multiplier:
              updates.tokenAccumulationCapMultiplier ??
              defaults?.tokenAccumulationCapMultiplier ??
              5,
            ai_enabled: updates.aiEnabled ?? defaults?.aiEnabled ?? false,
            requires_approval: updates.requiresApproval ?? defaults?.requiresApproval ?? false,
            is_active: updates.isActive ?? true,
            free_trial_days: updates.freeTrialDays ?? 0,
            max_sales: updates.maxSales ?? null,
            sales_count: updates.salesCount ?? 0,
            sort_order: updates.sortOrder ?? LEGACY_PLAN_IDS.indexOf(planId as PlanId) + 1,
            // stripe_price_id is NOT included here — updateFields handles it conditionally
            // so editing other fields never resets a previously-saved Stripe price ID to null
            ...updateFields,
          } as never,
          { onConflict: 'plan_id' }
        );

        if (error) {
          // Omit error.message and error.details from log — may expose schema/column names
          console.error('[admin/plans] Upsert error:', error.code ?? '[DB error]');
          return NextResponse.json({ error: 'Failed to update plan' }, { status: 500 });
        }

        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    console.error('[admin/plans] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
