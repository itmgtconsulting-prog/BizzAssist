/**
 * POST /api/ai/forklar-vurdering
 *
 * BIZZ-946: AI-drevet forklaring af ejendomsvurdering i klart dansk.
 * Modtager vurderingsdata og returnerer en letforståelig forklaring
 * af ejendomsværdi, grundværdi, skatteberegning og hvad det betyder.
 *
 * Streamer via SSE for progressiv visning.
 *
 * @param request - POST body med { vurdering, forelobig, adresse }
 * @returns SSE stream med { t } tekst-chunks og [DONE]
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';

/** Input-data for vurderingsforklaring */
interface VurderingInput {
  adresse: string;
  ejendomsvaerdi: number | null;
  grundvaerdi: number | null;
  vurderingsaar: number | null;
  forelobigEjendomsvaerdi: number | null;
  forelobigGrundvaerdi: number | null;
  forelobigGrundskyld: number | null;
  forelobigEjendomsvaerdiskat: number | null;
  forelobigTotalSkat: number | null;
  forelobigAar: number | null;
  boligareal: number | null;
  grundareal: number | null;
  opfoerelsesaar: number | null;
  kommune: string | null;
}

const CHUNK_SIZE = 30;

/**
 * Bygger system prompt til Claude.
 *
 * @returns System prompt
 */
function buildSystemPrompt(): string {
  return `Du er en dansk ejendomsrådgiver der forklarer ejendomsvurderinger i klart, letforståeligt dansk.

Du modtager data om en ejendoms vurdering og skatter. Skriv en kort, venlig forklaring (3-5 afsnit) der:

1. **Forklarer hvad ejendommen er vurderet til** — i normal tale, ikke jargon
2. **Forklarer grundværdien** — hvad jorden alene er værd, og hvorfor det er relevant
3. **Forklarer skatterne** — grundskyld og ejendomsværdiskat, hvad de dækker
4. **Sætter det i kontekst** — er det dyrt/billigt for området? Hvad betyder ændringer?
5. **Giver handlingsmuligheder** — hvad kan boligejeren gøre hvis de er uenige?

STIL:
- Skriv som om du taler med en ven der har købt sin første bolig
- Brug konkrete tal, ikke procentsatser alene
- Forklar forkortelser og fagtermer i parenteser
- Undgå juridisk sprog — skriv "din skat" ikke "den afgiftspligtige grundværdi"
- Maks 400 ord

VIGTIGT: Skriv direkte — ingen overskrifter eller bullet points. Brug korte afsnit.`;
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

  let input: VurderingInput;
  try {
    input = (await request.json()) as VurderingInput;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!input.adresse) {
    return NextResponse.json({ error: 'Mangler adresse' }, { status: 400 });
  }

  /* Formatér data til dansk prompt */
  const fmt = (n: number | null) => (n != null ? n.toLocaleString('da-DK') : 'ukendt');

  const userMessage = `Forklar denne ejendomsvurdering for mig:

Adresse: ${input.adresse}
Kommune: ${input.kommune ?? 'ukendt'}
Boligareal: ${input.boligareal ? `${fmt(input.boligareal)} m²` : 'ukendt'}
Grundareal: ${input.grundareal ? `${fmt(input.grundareal)} m²` : 'ukendt'}
Opført: ${input.opfoerelsesaar ?? 'ukendt'}

Officiel vurdering (${input.vurderingsaar ?? '?'}):
- Ejendomsværdi: ${input.ejendomsvaerdi ? `${fmt(input.ejendomsvaerdi)} DKK` : 'ikke vurderet'}
- Grundværdi: ${input.grundvaerdi ? `${fmt(input.grundvaerdi)} DKK` : 'ikke vurderet'}

Foreløbig vurdering (${input.forelobigAar ?? '?'}):
- Ejendomsværdi: ${input.forelobigEjendomsvaerdi ? `${fmt(input.forelobigEjendomsvaerdi)} DKK` : 'ingen'}
- Grundværdi: ${input.forelobigGrundvaerdi ? `${fmt(input.forelobigGrundvaerdi)} DKK` : 'ingen'}
- Grundskyld: ${input.forelobigGrundskyld ? `${fmt(input.forelobigGrundskyld)} DKK/år` : 'ukendt'}
- Ejendomsværdiskat: ${input.forelobigEjendomsvaerdiskat ? `${fmt(input.forelobigEjendomsvaerdiskat)} DKK/år` : 'ukendt'}
- Total skat: ${input.forelobigTotalSkat ? `${fmt(input.forelobigTotalSkat)} DKK/år` : 'ukendt'}`;

  /* ── SSE stream ── */
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sse = (data: string): void => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      try {
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: buildSystemPrompt(),
            messages: [{ role: 'user', content: userMessage }],
          },
          { signal: AbortSignal.timeout(15000) }
        );

        const textBlock = response.content.find((b) => b.type === 'text');
        if (textBlock && textBlock.type === 'text') {
          /* Stream teksten i chunks for smooth UI */
          for (let i = 0; i < textBlock.text.length; i += CHUNK_SIZE) {
            sse(JSON.stringify({ t: textBlock.text.slice(i, i + CHUNK_SIZE) }));
          }
        }

        sse('[DONE]');
        controller.close();
      } catch (err) {
        logger.error('[ai/forklar-vurdering] Fejl:', err);
        sse(JSON.stringify({ error: 'Ekstern API fejl' }));
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
