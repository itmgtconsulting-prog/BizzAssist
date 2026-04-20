/**
 * POST /api/support/chat
 *
 * Streaming support chat endpoint powered by Claude.
 * Tracks token usage separately from the user's main AI quota
 * using the `tenant.support_chat_sessions` table.
 *
 * Abuse protection:
 *  - Checks `public.support_chat_abuse` before calling Claude.
 *  - If permanently_locked → 403.
 *  - If locked_until is in the future → 429 with retry info.
 *  - After each request: sums tokens in the last 1 hour for the user.
 *  - If total > 50,000 tokens: escalating lockout applied.
 *    1st violation → 30 min, 2nd → 2h, 3rd → 24h, 4th+ → permanently_locked.
 *
 * SSE protocol (identical to /api/ai/chat):
 *  - `data: {"t":"<text>"}` — streamed text chunk
 *  - `data: {"error":"<msg>"}` — error
 *  - `data: [DONE]` — stream complete
 *
 * @param body.messages - Array of { role: 'user' | 'assistant', content: string }
 * @returns SSE stream
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';
import { writeAuditLog } from '@/app/lib/auditLog';
import { companyInfo } from '@/app/lib/companyInfo';

/** Zod schema for POST /api/support/chat request body */
const supportChatSchema = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
        })
      )
      .min(1),
  })
  .passthrough();

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum tokens used in a 1-hour window before triggering abuse detection */
const ABUSE_TOKEN_THRESHOLD = 50_000;

/** Lockout durations by violation count (minutes) */
const LOCKOUT_MINUTES: Record<number, number> = {
  1: 30,
  2: 120,
  3: 1440, // 24 hours
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface _ChatRequestBody {
  messages: ChatMessage[];
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SUPPORT_SYSTEM_PROMPT = `Du er BizzAssist Support Assistent. Du hjælper brugere med at bruge BizzAssist platformen.

Du kan hjælpe med:
- Navigation og funktioner i BizzAssist
- Forklaring af data (BBR, CVR, tinglysning, vurdering)
- Fejlfinding og tekniske spørgsmål
- Abonnement og fakturering
- GDPR og databeskyttelse

Du må IKKE:
- Lave CVR/BBR/ejendomsopslag — henvis brugeren til dashboardet
- Diskutere emner uden for BizzAssist platformen
- Besvare generelle spørgsmål der ikke relaterer sig til BizzAssist

Hold dine svar korte og præcise. Brug punktlister når du forklarer trin-for-trin. Svar på det samme sprog som brugeren skriver på.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Calculates minutes until a given ISO timestamp.
 *
 * @param until - ISO 8601 timestamp string
 * @returns Minutes remaining (rounded up), minimum 1
 */
function minutesUntil(until: string): number {
  const ms = new Date(until).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 60_000));
}

/**
 * Applies or escalates an abuse lockout for a user.
 * Upserts into `public.support_chat_abuse` using the admin client.
 * Non-critical — failures are logged but do not block the response.
 *
 * @param adminClient - Supabase admin client
 * @param userId - The user ID to lock
 * @param currentCount - Current violation_count (0 if first offence)
 */
async function applyAbuseLockout(
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string,
  currentCount: number
): Promise<void> {
  const newCount = currentCount + 1;
  const minutesToLock = LOCKOUT_MINUTES[newCount] ?? null;
  const permanentlyLocked = minutesToLock === null;
  const lockedUntil = permanentlyLocked
    ? null
    : new Date(Date.now() + minutesToLock! * 60_000).toISOString();

  await adminClient.from('support_chat_abuse').upsert(
    {
      user_id: userId,
      violation_count: newCount,
      locked_until: lockedUntil,
      permanently_locked: permanentlyLocked,
      last_violation: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  // Rate limit: reuse the AI rate limit bucket (10 req/min)
  const limited = await checkRateLimit(request, aiRateLimit);
  if (limited) return limited;

  // Require an authenticated user
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-652: Support-chat er bevidst IKKE gated via assertAiAllowed — ikke-
  // betalende brugere skal kunne stille spørgsmål for at nå frem til køb.
  // Misbrug forhindres i stedet af:
  //   1. `aiRateLimit` (10 req/min per IP, ovenfor)
  //   2. `public.support_chat_abuse`-tabel (50k tokens/time, eskalerende lockout)
  //   3. `ABUSE_TOKEN_THRESHOLD`-check nedenfor per request.
  // Se JSDoc øverst for det fulde abuse-mønster.
  const adminClient = createAdminClient();

  // ── Abuse check — runs BEFORE calling Claude to avoid wasting tokens ──
  const { data: abuseRow } = await adminClient
    .from('support_chat_abuse')
    .select('violation_count, locked_until, permanently_locked')
    .eq('user_id', user.id)
    .maybeSingle();

  if (abuseRow?.permanently_locked) {
    return Response.json(
      {
        error: `Din adgang til support-chat er spærret. Kontakt ${companyInfo.adminEmail}.`,
      },
      { status: 403 }
    );
  }

  if (abuseRow?.locked_until && new Date(abuseRow.locked_until) > new Date()) {
    const mins = minutesUntil(abuseRow.locked_until);
    return Response.json(
      {
        error: `For mange support-henvendelser. Prøv igen om ${mins} ${mins === 1 ? 'minut' : 'minutter'}.`,
        retryAfterMinutes: mins,
      },
      { status: 429 }
    );
  }

  // ── Resolve tenant membership for session recording ──
  const { data: membership } = (await adminClient
    .from('tenant_memberships')
    .select('tenant_id, tenants(schema_name)')
    .eq('user_id', user.id)
    .limit(1)
    .single()) as {
    data: { tenant_id: string; tenants: { schema_name: string } | null } | null;
  };

  if (!membership?.tenant_id) {
    return Response.json({ error: 'Tenant ikke fundet' }, { status: 403 });
  }

  const tenantId = membership.tenant_id;
  const schemaName = membership.tenants?.schema_name ?? null;

  // ── Monthly token limit for support chat (100k tokens/month per user) ──────
  // Checked against support_chat_sessions tokens_used column.
  // Fails-open on DB error to avoid blocking legitimate users.
  const SUPPORT_MONTHLY_LIMIT = 100_000;
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const db = tenantDb(schemaName ?? 'tenant');
    const { data: usageRows } = await db
      .from('support_chat_sessions')
      .select('tokens_used')
      .eq('user_id', user.id)
      .gte('created_at', monthStart.toISOString());

    const monthlyUsed = (usageRows ?? []).reduce(
      (sum: number, r: { tokens_used: number }) => sum + (r.tokens_used ?? 0),
      0
    );

    if (monthlyUsed >= SUPPORT_MONTHLY_LIMIT) {
      return new Response(
        JSON.stringify({
          error: 'Månedlig kvote for support-chat nået. Prøv igen næste måned.',
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }
  } catch {
    // Fail-open: do not block on DB error
  }

  // ── Hent brugerens abonnement og plan fra app_metadata ──────────────────────
  // Bruges til at give support-assistenten kontekst om den specifikke bruger.
  // Fejler stille — brugerkontekst er additivt og blokerer ikke chatten.
  let userContextBlock = '';
  try {
    const { data: freshUser } = await adminClient.auth.admin.getUserById(user.id);
    const sub = freshUser?.user?.app_metadata?.subscription as
      | {
          planId?: string;
          status?: string;
          tokensUsedThisMonth?: number;
          bonusTokens?: number;
          periodStart?: string;
          approvedAt?: string | null;
          isPaid?: boolean;
        }
      | null
      | undefined;

    const email = freshUser?.user?.email ?? user.email ?? '–';
    const fullName = (freshUser?.user?.user_metadata?.full_name as string | undefined) ?? '–';
    const planId = sub?.planId ?? 'ukendt';
    const status = sub?.status ?? 'ukendt';
    const tokensUsed = sub?.tokensUsedThisMonth ?? 0;
    const bonusTokens = sub?.bonusTokens ?? 0;
    const isPaid = sub?.isPaid ? 'ja' : 'nej';
    const approvedAt = sub?.approvedAt ? new Date(sub.approvedAt).toLocaleDateString('da-DK') : '–';
    const periodStart = sub?.periodStart
      ? new Date(sub.periodStart).toLocaleDateString('da-DK')
      : '–';

    // Look up the plan's display name from plan_configs
    const { data: planRow } = (await adminClient
      .from('plan_configs')
      .select('name_da, ai_tokens_per_month')
      .eq('plan_id', planId)
      .limit(1)
      .maybeSingle()) as { data: { name_da?: string; ai_tokens_per_month?: number } | null };

    const planNavn = planRow?.name_da ?? planId;
    const maxTokens = (planRow?.ai_tokens_per_month ?? 0) + bonusTokens;
    const tokenPct = maxTokens > 0 ? Math.round((tokensUsed / maxTokens) * 100) : 0;

    userContextBlock = `

## Bruger-kontekst (kun til brug i denne samtale — må ikke videregives til andre)
- **Navn:** ${fullName}
- **E-mail:** ${email}
- **Plan:** ${planNavn} (${planId})
- **Abonnementsstatus:** ${status}
- **Betalt:** ${isPaid}
- **Godkendt dato:** ${approvedAt}
- **Periode start:** ${periodStart}
- **AI tokens brugt denne måned:** ${tokensUsed.toLocaleString('da-DK')} / ${maxTokens.toLocaleString('da-DK')} (${tokenPct}%)
- **Bonus-tokens:** ${bonusTokens.toLocaleString('da-DK')}

Brug disse oplysninger til præcist at besvare spørgsmål om brugerens plan, forbrug og adgang.
Afslør IKKE oplysningerne medmindre brugeren spørger direkte til dem.`;
  } catch {
    // Non-critical — continue without user context
  }

  // ── Validate API key ──
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    // BIZZ-651: Generisk besked + buy-tokens CTA (ingen env-var-lækage)
    return Response.json(
      {
        error:
          'AI er midlertidigt utilgængelig. Bekræft at dit abonnement er aktivt, eller køb en token-pakke for at fortsætte.',
        code: 'ai_unavailable',
        cta: 'buy_token_pack',
      },
      { status: 503 }
    );
  }

  // ── Parse request body ──
  const parsed = await parseBody(request, supportChatSchema);
  if (!parsed.success) return parsed.response;
  const { messages } = parsed.data;

  // ── Input validation — guard against oversized payloads ──────────────────
  /** Maximum number of messages accepted per request (prevents token amplification). */
  const MAX_MESSAGES = 50;
  /** Maximum characters allowed per message content string. */
  const MAX_CONTENT_CHARS = 10_000;

  if (messages.length > MAX_MESSAGES) {
    return Response.json({ error: `Maks ${MAX_MESSAGES} beskeder pr. anmodning` }, { status: 400 });
  }

  const oversizedMessage = messages.find(
    (m) => typeof m.content === 'string' && m.content.length > MAX_CONTENT_CHARS
  );
  if (oversizedMessage) {
    return Response.json(
      { error: `Besked overstiger maks ${MAX_CONTENT_CHARS} tegn` },
      { status: 400 }
    );
  }

  // ── Sanitise messages — only allow valid roles ──
  const anthropicMessages: Anthropic.MessageParam[] = messages
    .filter((m): m is ChatMessage => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  if (anthropicMessages.length === 0) {
    return Response.json({ error: 'Ingen gyldige beskeder' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  /**
   * Helper: write an SSE event to the stream controller.
   *
   * @param controller - ReadableStream controller
   * @param data - Serialised SSE data payload
   */
  const sse = (controller: ReadableStreamDefaultController, data: string): void => {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      let totalTokens = 0;

      try {
        // ── Call Claude (single-turn, no tools) ──
        const response = await client.messages.create(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: SUPPORT_SYSTEM_PROMPT + userContextBlock,
            messages: anthropicMessages,
          },
          { signal: AbortSignal.timeout(30_000) }
        );

        const inputTokens = response.usage?.input_tokens ?? 0;
        const outputTokens = response.usage?.output_tokens ?? 0;
        totalTokens = inputTokens + outputTokens;

        // ── Stream the text response ──
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        const CHUNK = 200;
        for (let i = 0; i < text.length; i += CHUNK) {
          sse(controller, JSON.stringify({ t: text.slice(i, i + CHUNK) }));
        }

        sse(controller, '[DONE]');
        controller.close();
      } catch (err) {
        if (!(err instanceof Anthropic.APIError)) {
          Sentry.captureException(err);
        }
        const msg =
          err instanceof Anthropic.APIError
            ? `API-fejl (${err.status}): ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Ukendt fejl';
        sse(controller, JSON.stringify({ error: msg }));
        sse(controller, '[DONE]');
        controller.close();
      }

      // ── Post-response: record session + run abuse detection ──
      // Fire-and-forget async IIFE — must not delay or block the stream.
      // The structural type covers .from().insert() and .from().select().eq().gte()
      // used below; tenant schemas are not in the generated Database types.
      type TenantSchemaClient = {
        schema: (s: string) => {
          from: (t: string) => {
            insert(v: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
            select(cols?: string): {
              eq(
                c: string,
                v: unknown
              ): {
                gte(
                  c: string,
                  v: unknown
                ): PromiseLike<{
                  data: Record<string, unknown>[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
      const db = (adminClient as unknown as TenantSchemaClient).schema(schemaName ?? 'tenant');
      if (totalTokens > 0 && schemaName) {
        void (async () => {
          try {
            // Record token usage in the tenant schema
            await db
              .from('support_chat_sessions')
              .insert({ tenant_id: tenantId, user_id: user.id, tokens_used: totalTokens });

            // Fire-and-forget audit log entry for the support chat session (ISO 27001 A.12.4).
            void writeAuditLog({
              action: 'support_chat_started',
              resource_type: 'support_chat',
              resource_id: user.id,
              metadata: JSON.stringify({ tenantId, tokensUsed: totalTokens }),
            });

            // Abuse detection: sum tokens for this user in the last 1 hour
            const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
            const result = (await db
              .from('support_chat_sessions')
              .select('tokens_used')
              .eq('user_id', user.id)
              .gte('created_at', oneHourAgo)) as {
              data: Array<{ tokens_used: number }> | null;
              error: unknown;
            };

            if (result.error || !result.data) return;

            const hourlyTotal = result.data.reduce(
              (sum: number, r: { tokens_used: number }) => sum + (r.tokens_used ?? 0),
              0
            );

            if (hourlyTotal > ABUSE_TOKEN_THRESHOLD) {
              const currentCount = abuseRow?.violation_count ?? 0;
              await applyAbuseLockout(adminClient, user.id, currentCount);
            }
          } catch (err) {
            // Non-critical — log infra errors only, no PII
            logger.error(
              '[support/chat] post-response processing failed:',
              err instanceof Error ? err.message : String(err)
            );
          }
        })();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
