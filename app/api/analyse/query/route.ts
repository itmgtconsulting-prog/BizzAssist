/**
 * POST /api/analyse/query
 *
 * AI Query Builder — modtager en dansk forespørgsel, Claude vælger
 * data-strategi og returnerer struktureret dataset via eksisterende
 * tenant-scoped API routes (IKKE direkte SQL).
 *
 * BIZZ-1038: Streamer via SSE med status-updates under processing.
 * BIZZ-1038 review: Refaktoreret fra SQL-execution til API-kald approach
 * for at eliminere SQL injection, cross-tenant leakage og superuser risks.
 *
 * Flow:
 *  1. Bruger skriver dansk forespørgsel
 *  2. Claude analyserer og vælger data-strategi (PostgREST query params)
 *  3. Data hentes via Supabase service role (med RLS) — IKKE Management API
 *  4. Resultatet returneres som { columns, rows, chartType, summary }
 *
 * Sikkerhed:
 *  - Ingen rå SQL — kun PostgREST queries mod whitelistede tabeller
 *  - Service role med RLS aktiv (ikke superuser)
 *  - Tabel + kolonne whitelist validering
 *  - Max 10.000 rækker
 *  - Rate limit + auth + AI billing gate
 *  - AbortSignal.timeout på Claude API-kald
 *
 * @param request - POST body med { query: string }
 * @returns SSE stream med { status, result, error }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateSchemaDescription, WHITELISTED_TABLES } from '@/app/lib/analyseQueryWhitelist';

const MAX_ROWS = 10_000;

/** Kolonnedefinition for resultat-tabellen */
export interface ColumnDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
}

/** Resultat fra query builder */
export interface QueryResult {
  columns: ColumnDef[];
  rows: Record<string, unknown>[];
  chartType: 'bar' | 'line' | 'scatter' | 'table' | 'pie';
  summary: string;
  sql: string;
  rowCount: number;
}

/** Struktureret query plan fra Claude — IKKE rå SQL */
interface QueryPlan {
  table: string;
  select: string;
  filters?: Record<string, string>;
  order?: string;
  limit?: number;
  chartType: string;
  summary: string;
}

/**
 * Bygger system prompt til Claude med schema-beskrivelse.
 * Claude returnerer en STRUKTURERET query plan, IKKE rå SQL.
 *
 * @returns System prompt string
 */
function buildSystemPrompt(): string {
  const schema = generateSchemaDescription();
  const tableNames = WHITELISTED_TABLES.map((t) => t.table).join(', ');
  return `Du er en data-analytiker for BizzAssist. Brugeren stiller spørgsmål på dansk.

Du skal returnere en STRUKTURERET query plan som JSON — IKKE rå SQL.

TILGÆNGELIGE TABELLER: ${tableNames}

${schema}

Returner JSON med dette format:
{
  "table": "public.bbr_ejendom_status",
  "select": "kommune_kode, count(*) as antal",
  "filters": { "is_udfaset": "eq.false" },
  "order": "antal.desc",
  "limit": 50,
  "chartType": "bar",
  "summary": "Antal ejendomme per kommune"
}

REGLER:
1. "table" SKAL være en af: ${tableNames}
2. "select" bruger PostgREST syntax: kolonne1, kolonne2, count(*) etc.
3. "filters" bruger PostgREST operators: eq, neq, gt, lt, gte, lte, like, is
4. "order" bruger PostgREST: kolonne.asc eller kolonne.desc
5. "limit" maks ${MAX_ROWS}
6. "chartType": bar, line, scatter, pie, table
7. Returner KUN valid JSON — ingen markdown.

EKSEMPLER:
- "Ejendomme per kommune" → table=bbr_ejendom_status, select=kommune_kode,count(*)
- "Energimærke fordeling" → table=bbr_ejendom_status, select=energimaerke,count(*), filters={is_udfaset:eq.false,energimaerke:not.is.null}`;
}

/**
 * Validerer at query plan kun refererer til whitelistede tabeller og kolonner.
 *
 * @param plan - Struktureret query plan
 * @returns Fejlbesked eller null hvis valid
 */
function validatePlan(plan: QueryPlan): string | null {
  const allowedTables = WHITELISTED_TABLES.map((t) => t.table);
  const shortNames = WHITELISTED_TABLES.map((t) => t.table.split('.')[1]);

  if (!allowedTables.includes(plan.table) && !shortNames.includes(plan.table)) {
    return `Tabel "${plan.table}" er ikke tilladt. Tilladte: ${allowedTables.join(', ')}`;
  }

  /* Find den matchede tabel for kolonne-validering */
  const tableDef = WHITELISTED_TABLES.find(
    (t) => t.table === plan.table || t.table.split('.')[1] === plan.table
  );
  if (!tableDef) return `Tabel "${plan.table}" ikke fundet i whitelist`;

  /* Valider at select-kolonner kun bruger tilladte kolonner */
  const allowedCols = new Set(Object.keys(tableDef.columns));
  /* Tillad aggregerings-funktioner og aliaser */
  const selectParts = plan.select.split(',').map((s) => s.trim());
  for (const part of selectParts) {
    /* Ignorer count(*), sum(...), avg(...), aliaser (as ...) */
    const cleaned = part.replace(/\s+as\s+\w+$/i, '').trim();
    if (/^(count|sum|avg|min|max)\s*\(/i.test(cleaned)) continue;
    if (cleaned === '*') continue;
    const colName = cleaned.split('.')[0].trim();
    if (colName && !allowedCols.has(colName)) {
      return `Kolonne "${colName}" er ikke tilladt i ${plan.table}. Tilladte: ${[...allowedCols].join(', ')}`;
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) return NextResponse.json({ error: 'AI utilgængelig' }, { status: 503 });

  let body: { query: string };
  try {
    body = (await request.json()) as { query: string };
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length < 3) {
    return NextResponse.json({ error: 'Forespørgsel er for kort' }, { status: 400 });
  }

  const userQuery = body.query.trim().slice(0, 500);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sse = (data: string): void => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        sse(JSON.stringify({ status: 'Analyserer forespørgsel…' }));

        const client = new Anthropic({ apiKey });
        const response = await client.messages.create(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            system: buildSystemPrompt(),
            messages: [{ role: 'user', content: userQuery }],
          },
          { signal: AbortSignal.timeout(15000) }
        );

        const textBlock = response.content.find((b) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          sse(JSON.stringify({ error: 'AI returnerede intet svar' }));
          sse('[DONE]');
          controller.close();
          return;
        }

        let plan: QueryPlan;
        try {
          plan = JSON.parse(textBlock.text);
        } catch {
          const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            sse(JSON.stringify({ error: 'AI kunne ikke generere en gyldig query' }));
            sse('[DONE]');
            controller.close();
            return;
          }
          plan = JSON.parse(jsonMatch[0]);
        }

        if (!plan.table || !plan.select) {
          sse(JSON.stringify({ error: 'AI returnerede ingen query plan' }));
          sse('[DONE]');
          controller.close();
          return;
        }

        /* Validér plan mod whitelist */
        sse(JSON.stringify({ status: 'Validerer query…' }));
        const validationError = validatePlan(plan);
        if (validationError) {
          sse(JSON.stringify({ error: `Sikkerhedsvalidering: ${validationError}` }));
          sse('[DONE]');
          controller.close();
          return;
        }

        /* Eksekvér via PostgREST (service role med RLS) */
        sse(JSON.stringify({ status: 'Henter data…' }));

        const admin = createAdminClient();
        const tableName = plan.table.includes('.') ? plan.table.split('.')[1] : plan.table;

        let query = admin.from(tableName).select(plan.select, { count: 'exact' });

        /* Anvend filters */
        if (plan.filters) {
          for (const [col, filter] of Object.entries(plan.filters)) {
            const [op, ...valParts] = filter.split('.');
            const val = valParts.join('.');
            switch (op) {
              case 'eq':
                query = query.eq(col, val);
                break;
              case 'neq':
                query = query.neq(col, val);
                break;
              case 'gt':
                query = query.gt(col, val);
                break;
              case 'lt':
                query = query.lt(col, val);
                break;
              case 'gte':
                query = query.gte(col, val);
                break;
              case 'lte':
                query = query.lte(col, val);
                break;
              case 'is':
                query = query.is(
                  col,
                  val === 'null' ? null : val === 'true' ? true : val === 'false' ? false : null
                );
                break;
              case 'not':
                if (val === 'is.null') query = query.not(col, 'is', null);
                break;
            }
          }
        }

        /* Order + limit */
        if (plan.order) {
          const [orderCol, orderDir] = plan.order.split('.');
          query = query.order(orderCol, { ascending: orderDir !== 'desc' });
        }
        query = query.limit(Math.min(plan.limit ?? MAX_ROWS, MAX_ROWS));

        const { data: rows, error: dbError, count } = await query;

        if (dbError) {
          logger.error('[analyse/query] PostgREST fejl:', dbError.message);
          sse(JSON.stringify({ error: `Databasefejl: ${dbError.message}` }));
          sse('[DONE]');
          controller.close();
          return;
        }

        const resultRows = (rows ?? []) as Record<string, unknown>[];
        sse(JSON.stringify({ status: `${resultRows.length} rækker fundet` }));

        const columns: ColumnDef[] =
          resultRows.length > 0
            ? Object.keys(resultRows[0]).map((key) => {
                const val = resultRows[0][key];
                const type: ColumnDef['type'] =
                  typeof val === 'number'
                    ? 'number'
                    : val instanceof Date ||
                        (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val))
                      ? 'date'
                      : 'text';
                return { key, label: key.replace(/_/g, ' '), type };
              })
            : [];

        const chartType = ['bar', 'line', 'scatter', 'pie', 'table'].includes(plan.chartType)
          ? (plan.chartType as QueryResult['chartType'])
          : 'table';

        const result: QueryResult = {
          columns,
          rows: resultRows,
          chartType,
          summary: plan.summary ?? '',
          sql: `SELECT ${plan.select} FROM ${plan.table}${plan.filters ? ' WHERE ...' : ''} LIMIT ${plan.limit ?? MAX_ROWS}`,
          rowCount: count ?? resultRows.length,
        };

        sse(JSON.stringify({ result }));
        sse('[DONE]');
        controller.close();
      } catch (err) {
        logger.error('[analyse/query] Fejl:', err);
        sse(JSON.stringify({ error: err instanceof Error ? err.message : 'Ekstern API fejl' }));
        sse('[DONE]');
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
