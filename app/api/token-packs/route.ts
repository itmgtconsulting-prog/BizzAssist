/**
 * Public token packs listing — GET /api/token-packs
 *
 * Returns active token packs available for purchase.
 * Requires authentication.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/** Row shape from token_packs table. */
interface TokenPackRow {
  id: string;
  name_da: string;
  name_en: string;
  token_amount: number;
  price_dkk: number;
  is_active: boolean;
  sort_order: number;
}

/**
 * GET /api/token-packs — list active token packs.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();
    const { data, error } = (await admin
      .from('token_packs')
      .select('id, name_da, name_en, token_amount, price_dkk, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })) as {
      data: TokenPackRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      logger.error('[token-packs GET] DB error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const packs = (data ?? []).map((row) => ({
      id: row.id,
      nameDa: row.name_da,
      nameEn: row.name_en,
      tokenAmount: row.token_amount,
      priceDkk: row.price_dkk,
      sortOrder: row.sort_order,
    }));

    return NextResponse.json(packs);
  } catch (err) {
    logger.error('[token-packs] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
