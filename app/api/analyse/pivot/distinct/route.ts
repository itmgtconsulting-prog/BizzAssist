/**
 * GET /api/analyse/pivot/distinct?table=X&column=Y&q=Z
 *
 * BIZZ-1282: Returnerer distinkte værdier for en kolonne i en whitelistet tabel.
 * Bruges til intelligente filter-dropdowns i Pivot Analyse.
 *
 * @param table - Tabelnavn (kort form, fx "bbr_ejendom_status")
 * @param column - Kolonnenavn (fx "kommune_kode")
 * @param q - Valgfrit prefix-filter (ILIKE)
 * @returns { values: Array<{ value: string; count: number; label?: string }> }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { WHITELISTED_TABLES } from '@/app/lib/analyseQueryWhitelist';

/** Max antal distinkte værdier at returnere */
const MAX_VALUES = 30;

/** Kode→label mappings for kendte kode-felter */
const KOMMUNE_LABELS: Record<number, string> = {};
let kommuneLabelsLoaded = false;

/**
 * Hent kommune-labels fra kommune_ref (lazy-loaded).
 *
 * @param admin - Supabase admin client
 * @returns Map<kommunekode, kommunenavn>
 */
async function getKommuneLabels(
  admin: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>
): Promise<Record<number, string>> {
  if (kommuneLabelsLoaded) return KOMMUNE_LABELS;
  const { data } = await admin.from('kommune_ref').select('kommune_kode, kommunenavn').limit(200);
  for (const r of (data ?? []) as Array<{ kommune_kode: number; kommunenavn: string }>) {
    KOMMUNE_LABELS[r.kommune_kode] = r.kommunenavn;
  }
  kommuneLabelsLoaded = true;
  return KOMMUNE_LABELS;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const tableName = searchParams.get('table') ?? '';
  const column = searchParams.get('column') ?? '';
  const q = searchParams.get('q') ?? '';

  if (!tableName || !column) {
    return NextResponse.json({ error: 'Mangler table eller column' }, { status: 400 });
  }

  // Validér mod whitelist
  const tableDef = WHITELISTED_TABLES.find(
    (t) => t.table === tableName || t.table.split('.')[1] === tableName
  );
  if (!tableDef) {
    return NextResponse.json({ error: 'Tabel ikke i whitelist' }, { status: 400 });
  }
  if (!Object.keys(tableDef.columns).includes(column)) {
    return NextResponse.json({ error: 'Kolonne ikke i whitelist' }, { status: 400 });
  }

  const shortTable = tableDef.table.includes('.') ? tableDef.table.split('.')[1] : tableDef.table;
  const admin = createAdminClient();

  try {
    let query = admin.from(shortTable).select(column).not(column, 'is', null).limit(1000);

    // Prefix-filter
    if (q.trim()) {
      query = query.ilike(column, `${q.trim()}%`);
    }

    const { data: rows, error: dbErr } = await query;
    if (dbErr) {
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    // Tæl frekvens
    const freq = new Map<string, number>();
    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      const val = String(row[column] ?? '');
      freq.set(val, (freq.get(val) ?? 0) + 1);
    }

    // Sortér efter frekvens (mest brugte først)
    const sorted = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VALUES);

    // Tilføj labels for kode-felter
    let kommuneMap: Record<number, string> = {};
    if (column === 'kommune_kode') {
      kommuneMap = await getKommuneLabels(admin);
    }

    const values = sorted.map(([value, count]) => {
      let label: string | undefined;
      if (column === 'kommune_kode' && kommuneMap[Number(value)]) {
        label = kommuneMap[Number(value)];
      }
      return { value, count, label };
    });

    return NextResponse.json(
      { values },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' } }
    );
  } catch {
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
