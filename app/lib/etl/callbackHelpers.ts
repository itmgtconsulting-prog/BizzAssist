/**
 * Shared helpers for /api/etl/svar/* callback routes (BIZZ-1520/1521/1522/1523).
 *
 * Hver callback har samme overordnede pipeline:
 *   1. Læs XML body
 *   2. Verificer XMLDSig-signatur mod TINGLYSNING_RESPONSE_TRUST_CERT
 *   3. Parse message-specifik payload
 *   4. Persistér til DB
 *   5. Returnér 200 OK med tomt body
 *
 * Dette modul DRY'er steps 1+2+5 op til en typed result-discriminated union
 * så routes kun behøver at fokusere på parse + DB-logik.
 *
 * @module app/lib/etl/callbackHelpers
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyXmlSignature } from '@/app/lib/s2sClient';
import { logger } from '@/app/lib/logger';

/** Result fra verifyAndReadBody — caller fortsætter med parsing/persisting */
export type CallbackEntryResult = { ok: true; xml: string } | { ok: false; response: NextResponse };

/**
 * Læs body + verificer signatur. Returnerer enten { xml } til videre parsing
 * eller en færdig fail-response som caller skal returnere.
 *
 * @param request - NextRequest fra POST handler
 * @param routeTag - Log-prefix (fx 'etl/svar/fejl')
 */
export async function verifyAndReadCallbackBody(
  request: NextRequest,
  routeTag: string
): Promise<CallbackEntryResult> {
  let xml: string;
  try {
    xml = await request.text();
  } catch (err) {
    logger.warn(`[${routeTag}] body-læsning fejl`, err);
    return { ok: false, response: new NextResponse('Bad Request', { status: 400 }) };
  }
  if (!xml || xml.length < 10) {
    return { ok: false, response: new NextResponse('Empty body', { status: 400 }) };
  }

  const trustedCert = process.env.TINGLYSNING_RESPONSE_TRUST_CERT;
  if (!trustedCert) {
    logger.error(`[${routeTag}] TINGLYSNING_RESPONSE_TRUST_CERT mangler`);
    return { ok: false, response: new NextResponse('Server misconfigured', { status: 500 }) };
  }
  if (!verifyXmlSignature(xml, trustedCert)) {
    logger.warn(`[${routeTag}] signatur-verifikation fejlede`);
    return { ok: false, response: new NextResponse('Unauthorized', { status: 401 }) };
  }

  return { ok: true, xml };
}

/** Lazy service-role Supabase-klient */
let _client: SupabaseClient | null = null;

/** Reset (kun til tests) */
export function _resetCallbackClientForTests(): void {
  _client = null;
}

/**
 * Service-role Supabase-klient — caches mellem requests inden for samme cold
 * start. Returnerer null hvis env mangler.
 */
export function getCallbackServiceClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

/**
 * 200 OK med tomt body — standard succesvar til Tinglysning der ikke
 * forventer struktureret response på callbacks.
 */
export function ackResponse(): NextResponse {
  return new NextResponse('', { status: 200 });
}
