/**
 * POST /api/analyse/parse-police-pdf
 *
 * BIZZ-1228: Parser forsikringspolicer fra PDF via Claude AI.
 * Modtager base64-encodet PDF, sender til Claude med struktureret
 * extraction-prompt, returnerer ParsedPolice[].
 *
 * @param body.pdfBase64 - Base64-encodet PDF-indhold
 * @param body.fileName - Filnavn (til context)
 * @returns { policer: ParsedPolice[], rawText: string }
 *
 * @retention Ingen data persisteres — ren parsing.
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import { normaliserForsikringstype, type ParsedPolice } from '@/app/lib/parsePoliceFile';

export const maxDuration = 30;

/** Request body */
interface ParsePdfBody {
  pdfBase64: string;
  fileName?: string;
}

/** Claude extraction response */
interface ExtractedPolice {
  type: string;
  daekningssum: number | null;
  selskab: string | null;
  objekt: string | null;
  policenummer: string | null;
  udloebsdato: string | null;
}

const EXTRACTION_PROMPT = `Du modtager indholdet af en forsikringsoversigt eller -police i PDF-format.

Udtræk ALLE forsikringspolicer fra dokumentet og returnér dem som JSON-array.

For hver police, udtræk:
- type: forsikringstype (fx "Husforsikring", "Bilforsikring", "Indboforsikring", "Erhvervsforsikring", "Ansvarsforsikring", "Bygningsforsikring")
- daekningssum: dækningssum i DKK (heltal, null hvis ikke angivet)
- selskab: forsikringsselskabets navn (null hvis ikke angivet)
- objekt: forsikringsobjekt — adresse for ejendom, registreringsnummer for bil, virksomhedsnavn for erhverv (null hvis ikke angivet)
- policenummer: policenummer/aftalenummer (null hvis ikke angivet)
- udloebsdato: udløbsdato i YYYY-MM-DD format (null hvis ikke angivet)

Svar KUN med et JSON-array. Ingen forklaring, ingen markdown, ingen kommentarer.
Eksempel: [{"type":"Husforsikring","daekningssum":3500000,"selskab":"Alm Brand","objekt":"Søbyvej 11","policenummer":"123456","udloebsdato":"2025-12-31"}]`;

/**
 * POST handler — parser forsikrings-PDF via Claude.
 *
 * @param request - POST med pdfBase64
 * @returns { policer: ParsedPolice[] }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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

  let body: ParsePdfBody;
  try {
    body = (await request.json()) as ParsePdfBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.pdfBase64) {
    return NextResponse.json({ error: 'Mangler pdfBase64' }, { status: 400 });
  }

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: body.pdfBase64,
                },
              },
              {
                type: 'text',
                text: EXTRACTION_PROMPT,
              },
            ],
          },
        ],
      },
      { signal: AbortSignal.timeout(25000) }
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return NextResponse.json({ error: 'Intet svar fra AI' }, { status: 500 });
    }

    // Parse JSON response fra Claude
    let extracted: ExtractedPolice[] = [];
    try {
      // Claude kan wrappe i ```json ... ``` — strip det
      const cleaned = textBlock.text
        .replace(/^```json\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      extracted = JSON.parse(cleaned);
    } catch {
      logger.warn(
        '[parse-police-pdf] Kunne ikke parse Claude-svar som JSON:',
        textBlock.text.slice(0, 200)
      );
      return NextResponse.json(
        {
          error: 'AI-svar kunne ikke parses — prøv igen eller upload CSV i stedet',
          rawText: textBlock.text,
        },
        { status: 422 }
      );
    }

    // Map til ParsedPolice format
    const policer: ParsedPolice[] = extracted.map((e, i) => ({
      type: normaliserForsikringstype(e.type),
      rawType: e.type,
      daekningssum: e.daekningssum,
      selskab: e.selskab,
      objekt: e.objekt,
      policenummer: e.policenummer,
      udloebsdato: e.udloebsdato,
      linje: i + 1,
    }));

    return NextResponse.json({ policer, fileName: body.fileName ?? 'police.pdf' });
  } catch (err) {
    logger.error('[parse-police-pdf] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
