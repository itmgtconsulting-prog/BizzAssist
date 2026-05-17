/**
 * POST /api/analyse/pivot
 *
 * BIZZ-1260: Manuel pivot data-hentning — bruger vælger tabel, kolonner
 * og filtre manuelt. Ingen AI involveret.
 *
 * Sikkerhed:
 *  - Auth via resolveTenantId()
 *  - Rate limit
 *  - Tabel + kolonne whitelist validering
 *  - PostgREST via Supabase admin client med RLS
 *  - Max 10.000 rækker
 *
 * @param request - POST body: { table, columns?, filters? }
 * @returns JSON { columns, rows, totalCount }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { WHITELISTED_TABLES } from '@/app/lib/analyseQueryWhitelist';

const MAX_ROWS = 10_000;

/** Filter fra klienten */
interface PivotFilter {
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'is';
  value: string;
}

/** Request body */
interface PivotRequest {
  table: string;
  columns?: string[];
  filters?: PivotFilter[];
}

export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: PivotRequest;
  try {
    body = (await request.json()) as PivotRequest;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.table || typeof body.table !== 'string') {
    return NextResponse.json({ error: 'Tabel er påkrævet' }, { status: 400 });
  }

  /* Validér tabel mod whitelist */
  const tableDef = WHITELISTED_TABLES.find(
    (t) => t.table === body.table || t.table.split('.')[1] === body.table
  );
  if (!tableDef) {
    return NextResponse.json({ error: `Tabel "${body.table}" er ikke tilladt` }, { status: 400 });
  }

  const allowedCols = new Set(Object.keys(tableDef.columns));

  /* Validér kolonner mod whitelist */
  const requestedCols = body.columns?.length ? body.columns : Object.keys(tableDef.columns);
  for (const col of requestedCols) {
    if (!allowedCols.has(col)) {
      return NextResponse.json(
        { error: `Kolonne "${col}" er ikke tilladt i ${tableDef.table}` },
        { status: 400 }
      );
    }
  }

  /* Validér filtre */
  if (body.filters) {
    for (const f of body.filters) {
      if (!allowedCols.has(f.column)) {
        return NextResponse.json(
          { error: `Filterkolonne "${f.column}" er ikke tilladt` },
          { status: 400 }
        );
      }
      if (!['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'is'].includes(f.operator)) {
        return NextResponse.json({ error: `Ugyldig operator "${f.operator}"` }, { status: 400 });
      }
    }
  }

  try {
    const admin = createAdminClient();
    const tableName = tableDef.table.includes('.') ? tableDef.table.split('.')[1] : tableDef.table;

    const selectStr = requestedCols.join(',');
    let query = admin.from(tableName).select(selectStr, { count: 'exact' });

    /* Anvend filtre */
    if (body.filters) {
      for (const f of body.filters) {
        switch (f.operator) {
          case 'eq':
            query = query.eq(f.column, f.value);
            break;
          case 'neq':
            query = query.neq(f.column, f.value);
            break;
          case 'gt':
            query = query.gt(f.column, f.value);
            break;
          case 'lt':
            query = query.lt(f.column, f.value);
            break;
          case 'gte':
            query = query.gte(f.column, f.value);
            break;
          case 'lte':
            query = query.lte(f.column, f.value);
            break;
          case 'is':
            query = query.is(
              f.column,
              f.value === 'null'
                ? null
                : f.value === 'true'
                  ? true
                  : f.value === 'false'
                    ? false
                    : null
            );
            break;
        }
      }
    }

    query = query.limit(MAX_ROWS);

    const { data: rows, error: dbError, count } = await query;

    if (dbError) {
      logger.error('[analyse/pivot] PostgREST fejl:', dbError.message);
      return NextResponse.json({ error: 'Databasefejl' }, { status: 500 });
    }

    const resultRows = (rows ?? []) as Record<string, unknown>[];

    /* Byg kolonnedefinitioner med type-info fra whitelist */
    const columns = requestedCols.map((key) => ({
      key,
      label: key.replace(/_/g, ' '),
      type: tableDef.columns[key]?.type ?? 'text',
    }));

    return NextResponse.json({
      columns,
      rows: resultRows,
      totalCount: count ?? resultRows.length,
    });
  } catch (err) {
    logger.error('[analyse/pivot] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
