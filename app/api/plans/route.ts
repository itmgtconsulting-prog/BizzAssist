/**
 * Public plan listing API — GET /api/plans
 *
 * Returns merged plan data (hardcoded defaults + database overrides).
 * Used by settings page, signup flow, and token purchase page.
 * Requires authentication (but not admin).
 *
 * @see app/lib/subscriptions.ts — PlanDef defaults
 * @see app/api/admin/plans/route.ts — admin config mutations
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { PLANS, type PlanId } from '@/app/lib/subscriptions';
import { getStripePriceId } from '@/app/lib/stripe';
import { logger } from '@/app/lib/logger';

const VALID_PLAN_IDS: PlanId[] = ['demo', 'basis', 'professionel', 'enterprise'];

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
  token_accumulation_cap_multiplier: number;
  ai_enabled: boolean;
  requires_approval: boolean;
  is_active: boolean;
  free_trial_days: number;
  duration_days: number;
  max_sales: number | null;
  sales_count: number;
  stripe_price_id: string | null;
  sort_order: number;
}

/**
 * GET /api/plans — fetch all plans with DB overrides merged.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const admin = createAdminClient();
    const { data } = (await admin.from('plan_configs').select('*')) as {
      data: PlanConfigRow[] | null;
      error: unknown;
    };

    const dbMap = new Map<string, PlanConfigRow>();
    for (const row of data ?? []) {
      dbMap.set(row.plan_id, row);
    }

    // Build plans from legacy defaults + DB overrides, plus any custom (non-legacy) plans
    const legacyPlans = VALID_PLAN_IDS.map((id) => {
      const d = PLANS[id];
      const db = dbMap.get(id);
      return {
        id,
        nameDa: db?.name_da || d.nameDa,
        nameEn: db?.name_en || d.nameEn,
        descDa: db?.desc_da || d.descDa,
        descEn: db?.desc_en || d.descEn,
        color: db?.color || d.color,
        priceDkk: db?.price_dkk ?? d.priceDkk,
        aiTokensPerMonth: db?.ai_tokens_per_month ?? d.aiTokensPerMonth,
        durationMonths: db?.duration_months ?? d.durationMonths,
        durationDays: db?.duration_days ?? 0,
        tokenAccumulationCapMultiplier:
          db?.token_accumulation_cap_multiplier ?? d.tokenAccumulationCapMultiplier,
        aiEnabled: db?.ai_enabled ?? d.aiEnabled,
        requiresApproval: db?.requires_approval ?? d.requiresApproval,
        isActive: db?.is_active ?? true,
        freeTrialDays: db?.free_trial_days ?? 0,
        maxSales: db?.max_sales ?? null,
        salesCount: db?.sales_count ?? 0,
        // Use env var fallback (STRIPE_PRICE_BASIS etc.) when DB has no price ID
        stripePriceId: getStripePriceId(id, db?.stripe_price_id),
        // Default sort order mirrors VALID_PLAN_IDS position (1-based)
        sortOrder: db?.sort_order ?? VALID_PLAN_IDS.indexOf(id) + 1,
      };
    });

    // Include custom plans (non-legacy) from DB
    const customPlans = (data ?? [])
      .filter((row) => !VALID_PLAN_IDS.includes(row.plan_id as PlanId))
      .map((row) => ({
        id: row.plan_id,
        nameDa: row.name_da || row.plan_id,
        nameEn: row.name_en || row.plan_id,
        descDa: row.desc_da || '',
        descEn: row.desc_en || '',
        color: row.color || 'blue',
        priceDkk: row.price_dkk,
        aiTokensPerMonth: row.ai_tokens_per_month,
        durationMonths: row.duration_months,
        durationDays: row.duration_days ?? 0,
        tokenAccumulationCapMultiplier: row.token_accumulation_cap_multiplier,
        aiEnabled: row.ai_enabled,
        requiresApproval: row.requires_approval,
        isActive: row.is_active ?? true,
        freeTrialDays: row.free_trial_days ?? 0,
        maxSales: row.max_sales ?? null,
        salesCount: row.sales_count ?? 0,
        // Custom plans have no env var fallback — only DB source
        stripePriceId: row.stripe_price_id ?? null,
        sortOrder: row.sort_order ?? 99,
      }));

    const plans = [...legacyPlans, ...customPlans]
      .filter((p) => p.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return NextResponse.json(plans);
  } catch (err) {
    logger.error('[plans] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
