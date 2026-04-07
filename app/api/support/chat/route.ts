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
import Anthropic from '@anthropic-ai/sdk';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';

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

interface ChatRequestBody {
  messages: ChatMessage[];
}

interface AbuseRow {
  violation_count: number;
  locked_until: string | null;
  permanently_locked: boolean;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminClient: any,
  userId: string,
  currentCount: number
): Promise<void> {
  const newCount = currentCount + 1;
  const minutesToLock = LOCKOUT_MINUTES[newCount] ?? null;
  const permanentlyLocked = minutesToLock === null;
  const lockedUntil = permanentlyLocked
    ? null
    : new Date(Date.now() + minutesToLock! * 60_000).toISOString();

  await adminClient.schema('public').from('support_chat_abuse').upsert(
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

  const adminClient = createAdminClient();

  // ── Abuse check — runs BEFORE calling Claude to avoid wasting tokens ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const publicDb = (adminClient as unknown as { schema: (s: string) => any }).schema('public');
  const { data: abuseRow } = (await publicDb
    .from('support_chat_abuse')
    .select('violation_count, locked_until, permanently_locked')
    .eq('user_id', user.id)
    .maybeSingle()) as { data: AbuseRow | null };

  if (abuseRow?.permanently_locked) {
    return Response.json(
      {
        error: 'Din adgang til support-chat er spærret. Kontakt admin@bizzassist.dk.',
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

  // ── Validate API key ──
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });
  }

  // ── Parse request body ──
  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { messages } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'Ingen beskeder' }, { status: 400 });
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
            system: SUPPORT_SYSTEM_PROMPT,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (adminClient as unknown as { schema: (s: string) => any }).schema(
        schemaName ?? 'tenant'
      );
      if (totalTokens > 0 && schemaName) {
        void (async () => {
          try {
            // Record token usage in the tenant schema
            await db
              .from('support_chat_sessions')
              .insert({ tenant_id: tenantId, user_id: user.id, tokens_used: totalTokens });

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
            console.error(
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
