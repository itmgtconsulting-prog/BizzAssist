/**
 * POST /api/analysis/run
 *
 * Streaming analysis endpoint powered by Claude (claude-sonnet-4-6).
 * Accepts a structured analysis type and type-specific input fields,
 * builds a tailored system prompt, and streams the response as SSE.
 *
 * Supported analysis types:
 *  - due_diligence  — Grundig gennemgang af virksomhed eller ejendom
 *  - konkurrent     — Konkurrentanalyse inden for en branche
 *  - investering    — Investeringsscreening baseret på naturlig-sprog kriterier
 *  - marked         — Ejendomsmarkedsanalyse for et geografisk område
 *
 * SSE protocol (same as /api/ai/chat):
 *  - `data: {"t":"<text>"}` — streamed text chunks
 *  - `data: {"error":"<msg>"}` — error message
 *  - `data: [DONE]` — stream complete
 *
 * Rate limit: 5 req/min (heavy upstream Claude calls).
 * Auth: requires authenticated Supabase session via resolveTenantId().
 *
 * @param body.type  - Analysis type identifier
 * @param body.input - Type-specific input fields (strings only)
 * @returns SSE stream
 */

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { resolveTenantId } from '@/lib/api/auth';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Union of all supported analysis type identifiers */
type AnalysisType = 'due_diligence' | 'konkurrent' | 'investering' | 'marked';

/** Request body shape accepted by this endpoint */
interface AnalysisRequestBody {
  type: AnalysisType;
  input: Record<string, string>;
}

// ─── Rate limiter ────────────────────────────────────────────────────────────

/**
 * Dedicated analysis rate limiter — 5 req/min per IP.
 * Analyses are significantly heavier than chat messages (more tokens, longer context).
 * Initialised lazily to avoid build-time env-var errors.
 */
let _analysisRateLimit: Ratelimit | null = null;

/** Returns the lazily-initialised analysis rate limiter. */
function getAnalysisRateLimit(): Ratelimit {
  if (!_analysisRateLimit) {
    _analysisRateLimit = new Ratelimit({
      redis: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      limiter: Ratelimit.slidingWindow(5, '1 m'),
      analytics: true,
      prefix: 'ba:analysis-ratelimit',
    });
  }
  return _analysisRateLimit;
}

/**
 * Extract a stable per-client key from request headers for rate limiting.
 * Uses x-forwarded-for (Vercel / load balancers) then x-real-ip as fallback.
 * Note: IP is used only as a rate-limit key — never logged (ISO 27001).
 *
 * @param req - Incoming Next.js request
 * @returns Opaque client identifier string
 */
function getClientKey(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'anonymous';
}

// ─── System prompts ──────────────────────────────────────────────────────────

/**
 * Returns the system prompt for a given analysis type.
 *
 * @param type - Analysis type identifier
 * @returns System prompt string tailored to the analysis type
 */
function getSystemPrompt(type: AnalysisType): string {
  const prompts: Record<AnalysisType, string> = {
    due_diligence:
      'Du er en erfaren erhvervsjurist og finansanalytiker. Lav en grundig due diligence analyse med sektioner: ' +
      'Sammenfatning, Økonomi (nøgletal), Ejerskab & struktur, Risici, Regulatoriske forhold, Konklusion. ' +
      'Brug markdown-overskrifter (##) for sektioner. Vær præcis og faktabaseret. ' +
      'Anfør tydeligt hvis data ikke er tilgængeligt og hvad man bør undersøge videre.',

    konkurrent:
      'Du er en strategikonsulent. Lav en konkurrentanalyse med sektioner: ' +
      'Brancheoverblik, Virksomhedens position, Sammenligning med konkurrenter, Styrker/Svagheder, Muligheder/Trusler. ' +
      'Brug markdown-overskrifter (##) for sektioner. Basér analysen på offentligt tilgængelig brancheviden og CVR-data. ' +
      'Angiv hvilke data der ville styrke analysen hvis de var tilgængelige.',

    investering:
      'Du er en investeringsrådgiver. Screen investeringsmuligheder baseret på brugerens kriterier. ' +
      'Strukturér svaret med: Søgekriterier fortolket, Anbefalede ejendomstyper/områder, Nøglefaktorer at undersøge, ' +
      'Typiske prisintervaller for denne type aktiv, Risici og forbehold. ' +
      'Brug markdown-overskrifter (##) for sektioner. Vær konkret med geografiske og prismæssige anbefalinger.',

    marked:
      'Du er en ejendomsanalytiker. Lav en markedsanalyse med sektioner: ' +
      'Markedsoverblik, Prisudvikling, Handelsaktivitet, Nøgleindikatorer, Udsigter. ' +
      'Brug markdown-overskrifter (##) for sektioner. Basér analysen på generel viden om det danske ejendomsmarked ' +
      'og specifik viden om det efterspurgte geografiske område.',
  };

  return prompts[type];
}

/**
 * Builds the user-facing prompt from the analysis type and input fields.
 * Each input field is formatted as a labelled line to give Claude clear context.
 *
 * @param type  - Analysis type identifier
 * @param input - Type-specific input fields from the user form
 * @returns Formatted user prompt string
 */
function buildUserPrompt(type: AnalysisType, input: Record<string, string>): string {
  const typeLabels: Record<AnalysisType, string> = {
    due_diligence: 'Due Diligence Analyse',
    konkurrent: 'Konkurrentanalyse',
    investering: 'Investeringsscreening',
    marked: 'Markedsanalyse',
  };

  const lines: string[] = [`Lav en ${typeLabels[type]} baseret på følgende input:`, ''];

  for (const [key, value] of Object.entries(input)) {
    if (value.trim()) {
      lines.push(`**${key}:** ${value.trim()}`);
    }
  }

  lines.push('', 'Lav analysen grundigt og struktureret efter de definerede sektioner.');
  return lines.join('\n');
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/analysis/run
 *
 * Authenticates the user, applies rate limiting, builds a type-specific
 * prompt, calls Claude with streaming, and returns an SSE response.
 *
 * @param request - Incoming Next.js request with AnalysisRequestBody as JSON
 * @returns SSE stream or error NextResponse
 */
export async function POST(request: NextRequest): Promise<Response> {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const identifier = getClientKey(request);
  const { success, limit, remaining, reset } = await getAnalysisRateLimit().limit(identifier);
  if (!success) {
    return NextResponse.json(
      { error: 'For mange anmodninger — prøv igen om et øjeblik', code: 'RATE_LIMIT_EXCEEDED' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': limit.toString(),
          'X-RateLimit-Remaining': remaining.toString(),
          'X-RateLimit-Reset': reset.toString(),
          'Retry-After': Math.ceil((reset - Date.now()) / 1000).toString(),
        },
      }
    );
  }

  // ── API key ─────────────────────────────────────────────────────────────────
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });
  }

  // ── Parse + validate request body ───────────────────────────────────────────
  let body: AnalysisRequestBody;
  try {
    body = (await request.json()) as AnalysisRequestBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const VALID_TYPES: AnalysisType[] = ['due_diligence', 'konkurrent', 'investering', 'marked'];
  if (!body.type || !VALID_TYPES.includes(body.type)) {
    return NextResponse.json(
      { error: `Ugyldig analysetype. Gyldige typer: ${VALID_TYPES.join(', ')}` },
      { status: 400 }
    );
  }

  if (!body.input || typeof body.input !== 'object') {
    return NextResponse.json({ error: 'input skal være et objekt' }, { status: 400 });
  }

  // Validate that all input values are strings and not excessively long
  const MAX_INPUT_CHARS = 2000;
  for (const [key, value] of Object.entries(body.input)) {
    if (typeof value !== 'string') {
      return NextResponse.json(
        { error: `Input-felt '${key}' skal være en tekststreng` },
        { status: 400 }
      );
    }
    if (value.length > MAX_INPUT_CHARS) {
      return NextResponse.json(
        { error: `Input-felt '${key}' overstiger maks ${MAX_INPUT_CHARS} tegn` },
        { status: 400 }
      );
    }
  }

  // ── Build prompts ────────────────────────────────────────────────────────────
  const systemPrompt = getSystemPrompt(body.type);
  const userPrompt = buildUserPrompt(body.type, body.input);

  // ── Stream from Claude ───────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  /**
   * Enqueue a single SSE event on the stream controller.
   *
   * @param controller - ReadableStream controller
   * @param data       - Raw SSE data string (without the "data: " prefix)
   */
  const sse = (controller: ReadableStreamDefaultController, data: string): void => {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Use streaming API for direct text output — no tool rounds needed for analysis
        const response = await client.messages.create(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            stream: true,
          },
          { signal: AbortSignal.timeout(60000) }
        );

        for await (const event of response) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text
          ) {
            sse(controller, JSON.stringify({ t: event.delta.text }));
          }
        }

        sse(controller, '[DONE]');
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Ukendt serverfejl';
        sse(controller, JSON.stringify({ error: message }));
        sse(controller, '[DONE]');
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
