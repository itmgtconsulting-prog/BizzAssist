/**
 * POST /api/analyse/query
 *
 * AI Query Builder — modtager en dansk forespørgsel, genererer SQL via Claude,
 * validerer mod whitelist, eksekverer via Supabase Management API og returnerer
 * struktureret dataset.
 *
 * BIZZ-1038: Streamer via SSE med status-updates under processing.
 *
 * Flow:
 *  1. Bruger skriver dansk forespørgsel (fx "vis gennemsnitligt boligareal per kommune")
 *  2. Claude genererer parameteriseret SELECT query mod whitelistede tabeller
 *  3. Query valideres mod whitelist (tabel + kolonne check)
 *  4. Query eksekveres via Supabase Management API (superuser, read-only)
 *  5. Resultatet returneres som { columns, rows, chartType, summary }
 *
 * Sikkerhed:
 *  - Kun SELECT queries tilladt (valideres af whitelist)
 *  - Valideres mod whitelist af tabeller/kolonner
 *  - Max 10.000 rækker returneres
 *  - 30s query timeout
 *  - Rate limit: 10/min per bruger
 *  - Kræver auth + AI billing gate
 *
 * @param request - POST body med { query: string }
 * @returns SSE stream med { status, sql, columns, rows, chartType, summary, error }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { generateSchemaDescription, validateQuery } from '@/app/lib/analyseQueryWhitelist';

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

/**
 * Bygger system prompt til Claude med schema-beskrivelse.
 *
 * @returns System prompt string
 */
function buildSystemPrompt(): string {
  const schema = generateSchemaDescription();
  return `Du er en SQL-analytiker for BizzAssist — et dansk ejendoms- og virksomhedsdata-system.

Brugeren stiller spørgsmål på dansk om ejendomme og virksomheder. Du skal generere en SQL SELECT-query der besvarer spørgsmålet.

REGLER:
1. Generer KUN SELECT queries — ingen INSERT, UPDATE, DELETE eller DDL
2. Brug KUN de tabeller og kolonner der er listet nedenfor
3. Tilføj altid LIMIT ${MAX_ROWS} for at undgå store resultatsæt
4. For aggregeringer: brug GROUP BY med meningsfulde labels
5. For regnskab_cache.years: brug jsonb_array_elements for at udpakke årsdata
6. Returner resultatet som JSON med følgende format:
   {
     "sql": "SELECT ...",
     "chartType": "bar" | "line" | "scatter" | "table" | "pie",
     "summary": "Kort dansk forklaring af hvad queryen viser"
   }

TILGÆNGELIGE TABELLER:
${schema}

EKSEMPLER:
- "Hvor mange ejendomme per kommune?" → GROUP BY kommune_kode, COUNT(*)
- "Gennemsnitligt boligareal per opførelsesår" → GROUP BY opfoerelsesaar, AVG(samlet_boligareal)
- "Energimærkeklasse fordeling" → GROUP BY energimaerke, COUNT(*)

Returner ALTID valid JSON — ingen markdown, ingen kodeblokke.`;
}

/**
 * Eksekverer en read-only SQL query via Supabase Management API.
 *
 * @param sql - SQL query der skal eksekveres
 * @returns Array af resultat-rækker
 */
async function executeReadonlyQuery(sql: string): Promise<Record<string, unknown>[]> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

  /* Udled project ref fra URL: https://XYZ.supabase.co → XYZ */
  const refMatch = supabaseUrl.match(/https:\/\/([^.]+)\.supabase/);
  const projectRef = refMatch?.[1];

  if (!token || !projectRef) {
    throw new Error('Mangler SUPABASE_ACCESS_TOKEN eller NEXT_PUBLIC_SUPABASE_URL');
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SQL fejl (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  return (await res.json()) as Record<string, unknown>[];
}

export async function POST(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'AI utilgængelig' }, { status: 503 });
  }

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

  /* ── SSE stream ── */
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sse = (data: string): void => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        /* Trin 1: Claude genererer SQL */
        sse(JSON.stringify({ status: 'Analyserer forespørgsel…' }));

        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: buildSystemPrompt(),
          messages: [{ role: 'user', content: userQuery }],
        });

        const textBlock = response.content.find((b) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          sse(JSON.stringify({ error: 'AI returnerede intet svar' }));
          sse('[DONE]');
          controller.close();
          return;
        }

        /* Parse Claude's JSON response */
        let parsed: { sql: string; chartType: string; summary: string };
        try {
          parsed = JSON.parse(textBlock.text);
        } catch {
          /* Forsøg at finde JSON i teksten */
          const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            sse(JSON.stringify({ error: 'AI kunne ikke generere en gyldig query' }));
            sse('[DONE]');
            controller.close();
            return;
          }
          parsed = JSON.parse(jsonMatch[0]);
        }

        if (!parsed.sql) {
          sse(JSON.stringify({ error: 'AI returnerede ingen SQL query' }));
          sse('[DONE]');
          controller.close();
          return;
        }

        /* Trin 2: Validér SQL mod whitelist */
        sse(JSON.stringify({ status: 'Validerer query…' }));
        const validationError = validateQuery(parsed.sql);
        if (validationError) {
          sse(JSON.stringify({ error: `Sikkerhedsvalidering fejlede: ${validationError}` }));
          sse('[DONE]');
          controller.close();
          return;
        }

        /* Trin 3: Eksekvér SQL */
        sse(JSON.stringify({ status: 'Henter data…', sql: parsed.sql }));

        const resultRows = await executeReadonlyQuery(parsed.sql);

        /* Trin 4: Formatér resultat */
        sse(JSON.stringify({ status: `${resultRows.length} rækker fundet` }));

        /* Udled kolonner fra første række */
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

        const chartType = ['bar', 'line', 'scatter', 'pie', 'table'].includes(parsed.chartType)
          ? (parsed.chartType as QueryResult['chartType'])
          : 'table';

        const result: QueryResult = {
          columns,
          rows: resultRows.slice(0, MAX_ROWS),
          chartType,
          summary: parsed.summary ?? '',
          sql: parsed.sql,
          rowCount: resultRows.length,
        };

        sse(JSON.stringify({ result }));
        sse('[DONE]');
        controller.close();
      } catch (err) {
        logger.error('[analyse/query] Uventet fejl:', err);
        sse(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'Ekstern API fejl',
          })
        );
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
