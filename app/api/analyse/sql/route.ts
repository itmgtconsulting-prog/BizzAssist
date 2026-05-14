/**
 * POST /api/analyse/sql — BIZZ-1426 (Fase 3, Lag 3)
 *
 * Smart SQL endpoint: brugerens dansk-prompt → AI genererer PostgreSQL SELECT
 * → AST-validator (BIZZ-1424) → eksekvér read-only (BIZZ-1425) → audit log.
 *
 * Sikkerheds-stack:
 *   1. resolveTenantId() + 401 if unauth
 *   2. assertAiAllowed() — AI billing gate
 *   3. rate-limit (20/min per tenant)
 *   4. Claude SDK med AbortSignal.timeout(15s)
 *   5. validateSql() — AST/keyword/whitelist validation
 *   6. executeSafeSql() — read-only execution
 *   7. INSERT audit row uanset success/fail
 *
 * Returner JSON: { sql, columns, rows, durationMs, truncated, rowCount, error? }
 *
 * @module app/api/analyse/sql
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { validateSql } from '@/app/lib/dataIntelligence/sqlValidator';
import { executeSafeSql } from '@/app/lib/dataIntelligence/sqlExecutor';
import { buildSqlGenPrompt } from '@/app/lib/dataIntelligence/sqlGenPrompt';
import { createDefaultSqlRunner } from '@/app/lib/dataIntelligence/buildCatalog';

export const runtime = 'nodejs';
// Claude generation + SQL execution mod 2.2M-row tabeller kan tage 25-60s
// (særligt level 3 joins på ejf_ejerskab 7.6M rækker). Sætter til 90 så
// Vercel ikke killer requesten — projektet er på Pro+ med 300s loft.
export const maxDuration = 90;

interface RequestBody {
  prompt: string;
}

interface ResponseBody {
  ok: boolean;
  sql: string;
  /** Forklaring hvis AI ikke kunne generere SQL */
  explanation?: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

/** Insert audit-row til dataintel.ai_sql_audit (best-effort — fejl må ikke bryde flow). */
async function logAudit(
  tenantId: string,
  userId: string,
  userPrompt: string,
  generatedSql: string,
  astValidated: boolean,
  executed: boolean,
  rowCount: number | null,
  durationMs: number | null,
  error: string | null
): Promise<void> {
  try {
    const rpc = createDefaultSqlRunner();
    const esc = (s: string): string => s.replace(/'/g, "''");
    const sql = `INSERT INTO dataintel.ai_sql_audit (tenant_id, user_id, user_prompt, generated_sql, ast_validated, executed, row_count, duration_ms, error) VALUES ('${tenantId}', '${userId}', '${esc(userPrompt)}', '${esc(generatedSql)}', ${astValidated}, ${executed}, ${rowCount ?? 'NULL'}, ${durationMs ?? 'NULL'}, ${error ? `'${esc(error)}'` : 'NULL'})`;
    await rpc(sql);
  } catch (err) {
    logger.warn('[analyse/sql] audit insert failed:', err);
  }
}

/**
 * Generer SQL fra dansk prompt via Claude.
 */
async function generateSql(
  apiKey: string,
  prompt: string
): Promise<{ sql: string; explanation?: string }> {
  const client = new Anthropic({ apiKey });
  const systemPrompt = await buildSqlGenPrompt();
  const res = await client.messages.create(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    },
    { signal: AbortSignal.timeout(15000) }
  );

  // Extract text from response
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Check for FORKLARING: prefix
  if (text.startsWith('FORKLARING:')) {
    return { sql: '', explanation: text.slice('FORKLARING:'.length).trim() };
  }

  // Strip markdown code-blocks hvis Claude indsætter dem alligevel
  const cleaned = text
    .replace(/^```sql\n?/i, '')
    .replace(/\n?```$/, '')
    .replace(/^```\n?/, '')
    .trim();

  return { sql: cleaned };
}

/**
 * POST handler.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const start = Date.now();

  // Rate limit
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  // Auth
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // AI gate
  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  // Claude API key
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'AI utilgængelig' }, { status: 503 });
  }

  // Parse body
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }
  const userPrompt = (body?.prompt ?? '').trim();
  if (!userPrompt || userPrompt.length < 3 || userPrompt.length > 1000) {
    return NextResponse.json({ error: 'Prompt skal være 3-1000 tegn' }, { status: 400 });
  }

  // 1. Generér SQL via Claude
  let generated: { sql: string; explanation?: string };
  try {
    generated = await generateSql(apiKey, userPrompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Claude-fejl';
    logger.warn('[analyse/sql] Claude generation failed:', msg);
    await logAudit(auth.tenantId, auth.userId, userPrompt, '', false, false, null, null, msg);
    return NextResponse.json(
      {
        ok: false,
        error: 'Ekstern API fejl',
        durationMs: Date.now() - start,
      } as Partial<ResponseBody>,
      { status: 502 }
    );
  }

  // Hvis AI gav forklaring i stedet for SQL → returnér det
  if (generated.explanation) {
    await logAudit(
      auth.tenantId,
      auth.userId,
      userPrompt,
      `(forklaring) ${generated.explanation}`,
      false,
      false,
      null,
      Date.now() - start,
      null
    );
    return NextResponse.json({
      ok: true,
      sql: '',
      explanation: generated.explanation,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      durationMs: Date.now() - start,
    } as ResponseBody);
  }

  const rawSql = generated.sql;

  // 2. Validér
  const validation = validateSql(rawSql);
  if (!validation.valid) {
    await logAudit(
      auth.tenantId,
      auth.userId,
      userPrompt,
      rawSql,
      false,
      false,
      null,
      Date.now() - start,
      validation.reason ?? 'Validation fail'
    );
    return NextResponse.json(
      {
        ok: false,
        sql: rawSql,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: Date.now() - start,
        error: `SQL afvist: ${validation.reason}`,
      } as ResponseBody,
      { status: 400 }
    );
  }

  // 3. Eksekvér
  const exec = await executeSafeSql(validation.sanitized_sql);
  await logAudit(
    auth.tenantId,
    auth.userId,
    userPrompt,
    validation.sanitized_sql,
    true,
    exec.ok,
    exec.rowCount,
    exec.durationMs,
    exec.error ?? null
  );

  if (!exec.ok) {
    return NextResponse.json(
      {
        ok: false,
        sql: validation.sanitized_sql,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: Date.now() - start,
        error: `Eksekvering fejlede: ${exec.error}`,
      } as ResponseBody,
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    sql: validation.sanitized_sql,
    columns: exec.columns,
    rows: exec.rows,
    rowCount: exec.rowCount,
    truncated: exec.truncated,
    durationMs: Date.now() - start,
  } as ResponseBody);
}
