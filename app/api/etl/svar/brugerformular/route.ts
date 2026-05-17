/**
 * POST /api/etl/svar/brugerformular — BrugerformularSvar callback fra Tinglysning.
 *
 * Tinglysning sender denne callback når en bruger har udfyldt en formular
 * i Tinglysningssystemet (typisk underskrift-bekraeftelse eller anmodning
 * om yderligere oplysninger). Vi persisterer form-data i
 * `public.tinglysning_brugerformular` så det kan vises i UI'en.
 *
 * Flow:
 *   1. Verificer XMLDSig-signatur
 *   2. Parse FormularID + FormularType + Kundereference + form-data
 *   3. Resolve anmeldelse_id via kundereference (FK til tinglysning_anmeldelse)
 *   4. INSERT — UNIQUE message_id sikrer idempotency
 *   5. 200 OK
 *
 * @module api/etl/svar/brugerformular
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import {
  ackResponse,
  getCallbackServiceClient,
  verifyAndReadCallbackBody,
} from '@/app/lib/etl/callbackHelpers';

export const runtime = 'nodejs';

interface ParsedFormular {
  messageId: string;
  formularId: string | null;
  formularType: string | null;
  kundereference: string | null;
  /** Form-data som key/value-records — kun primitive felter ekstraheres */
  formData: Record<string, string>;
}

/**
 * Parser BrugerformularSvar. Henter alle <Felt><Navn>X</Navn><Vaerdi>Y</Vaerdi></Felt>
 * blokke ind i et flat key/value map. Robust mod attributter og whitespace.
 */
function parseBrugerformularSvar(xml: string): ParsedFormular | null {
  const messageId = xml.match(/<MessageID>([^<]+)<\/MessageID>/i)?.[1] ?? null;
  if (!messageId) return null;

  const formularId =
    xml.match(/<FormularID>([^<]+)<\/FormularID>/i)?.[1] ??
    xml.match(/<FormularId>([^<]+)<\/FormularId>/i)?.[1] ??
    null;
  const formularType = xml.match(/<FormularType>([^<]+)<\/FormularType>/i)?.[1] ?? null;
  const kundereference = xml.match(/<Kundereference>([^<]+)<\/Kundereference>/i)?.[1] ?? null;

  // Ekstrahér alle <Felt><Navn>...<Vaerdi>... blokke
  const formData: Record<string, string> = {};
  const feltRegex = /<Felt>\s*<Navn>([^<]+)<\/Navn>\s*<Vaerdi>([^<]*)<\/Vaerdi>\s*<\/Felt>/gi;
  let m: RegExpExecArray | null;
  while ((m = feltRegex.exec(xml)) !== null) {
    formData[m[1].trim()] = m[2].trim();
  }

  return { messageId, formularId, formularType, kundereference, formData };
}

/**
 * POST handler — verify + parse + persist + 200.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const entry = await verifyAndReadCallbackBody(request, 'etl/svar/brugerformular');
  if (!entry.ok) return entry.response;
  const xml = entry.xml;

  const parsed = parseBrugerformularSvar(xml);
  if (!parsed) {
    logger.warn('[etl/svar/brugerformular] kunne ikke parse messageId');
    return new NextResponse('OK', { status: 200 });
  }

  const client = getCallbackServiceClient();
  if (!client) {
    logger.error('[etl/svar/brugerformular] Supabase-klient utilgængelig');
    return new NextResponse('Server error', { status: 500 });
  }

  // Resolve anmeldelse_id via kundereference hvis muligt
  let anmeldelseId: string | null = null;
  if (parsed.kundereference) {
    try {
      const { data } = await client
        .from('tinglysning_anmeldelse')
        .select('id')
        .eq('tinglysning_message_id', parsed.kundereference)
        .maybeSingle<{ id: string }>();
      anmeldelseId = data?.id ?? null;
    } catch {
      // fail-soft — vi insert'er stadig uden anmeldelse_id
    }
  }

  try {
    const { error } = await client.from('tinglysning_brugerformular').insert({
      anmeldelse_id: anmeldelseId,
      formular_id: parsed.formularId,
      formular_type: parsed.formularType,
      kundereference: parsed.kundereference,
      form_data: parsed.formData,
      tinglysning_message_id: parsed.messageId,
      raw_xml: xml,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') return ackResponse(); // idempotent replay
      logger.error('[etl/svar/brugerformular] DB insert fejl', { error });
      return new NextResponse('DB error', { status: 500 });
    }
  } catch (err) {
    logger.error('[etl/svar/brugerformular] uventet fejl', err);
    return new NextResponse('Server error', { status: 500 });
  }

  return ackResponse();
}
