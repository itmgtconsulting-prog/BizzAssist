/**
 * POST /api/etl/svar/fejl — FejlService callback fra Tinglysningsretten.
 *
 * Tinglysning sender denne callback til os når en S2S-anmeldelse fejler
 * undervejs (validering, signatur, business-rule violation osv). Vi
 * verificerer signaturen, parser fejl-information, og opdaterer
 * `public.tinglysning_anmeldelse` med status='fejl' for den matching
 * message_id.
 *
 * Flow:
 *   1. Verificer XMLDSig-signatur mod TINGLYSNING_RESPONSE_TRUST_CERT
 *      (afviser 401 ved invalid/tampered)
 *   2. Parse <FejlMeddelelse><Identifikator>...</Identifikator> for
 *      tinglysning-message-id der mapper til vores anmeldelse
 *   3. Parse <FejlKode> + <FejlTekst>
 *   4. UPDATE public.tinglysning_anmeldelse SET status='fejl', error_message,
 *      fejl_kode, fejl_modtaget_at, resolved_at WHERE tinglysning_message_id=...
 *   5. Returnér 200 OK med tomt body (Tinglysning forventer denne form)
 *
 * Notifikation (in-app + Resend email til admin) er deferred til separat
 * follow-up ticket — kræver UI-design af notifikations-feed først.
 *
 * @module api/etl/svar/fejl
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyXmlSignature } from '@/app/lib/s2sClient';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

/** Strukturert parsed fejl-payload */
interface ParsedFejl {
  /** Tinglysning's message-id der refererer tilbage til vores oprindelige request */
  messageId: string;
  /** Fejlkode fra Tinglysning (fx 'VAL-001') */
  fejlKode: string | null;
  /** Læselig fejlbeskrivelse */
  fejlTekst: string;
}

/**
 * Parse FejlSvar XML. Bruger tolerant regex i stedet for fuld XML-parser
 * fordi message-strukturen er stabil og vi har allerede signatur-verificeret.
 *
 * @param xml - Verificeret signed XML
 * @returns Parsed payload eller null hvis kritiske felter mangler
 */
function parseFejlSvar(xml: string): ParsedFejl | null {
  const messageId =
    xml.match(/<MessageID>([^<]+)<\/MessageID>/i)?.[1] ??
    xml.match(/<Identifikator>([^<]+)<\/Identifikator>/i)?.[1] ??
    null;
  if (!messageId) return null;

  const fejlKode =
    xml.match(/<FejlKode>([^<]+)<\/FejlKode>/i)?.[1] ??
    xml.match(/<faultcode[^>]*>([^<]+)<\/faultcode>/i)?.[1] ??
    null;

  const fejlTekst =
    xml.match(/<FejlTekst>([^<]+)<\/FejlTekst>/i)?.[1] ??
    xml.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i)?.[1] ??
    'ukendt fejl';

  return { messageId, fejlKode, fejlTekst };
}

/**
 * Service-role Supabase-klient til at opdatere på tværs af tenant.
 */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Handler — verificer + parse + opdater + 200 OK.
 *
 * Returnerer ALDRIG 5xx for andre årsager end intern fejl (Tinglysning
 * retryer ved 5xx, så vi vil ikke have dem til at retry for "ukendt
 * message_id" — det er deterministisk en business-fejl der ikke vil hjælpe
 * af retry).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let xml: string;
  try {
    xml = await request.text();
  } catch (err) {
    logger.warn('[etl/svar/fejl] kunne ikke læse body', err);
    return new NextResponse('Bad Request', { status: 400 });
  }

  if (!xml || xml.length < 10) {
    return new NextResponse('Empty body', { status: 400 });
  }

  // ─── Verificer signatur ──────────────────────────────────────────────
  const trustedCert = process.env.TINGLYSNING_RESPONSE_TRUST_CERT;
  if (!trustedCert) {
    logger.error('[etl/svar/fejl] TINGLYSNING_RESPONSE_TRUST_CERT ikke konfigureret');
    return new NextResponse('Server misconfigured', { status: 500 });
  }
  if (!verifyXmlSignature(xml, trustedCert)) {
    logger.warn('[etl/svar/fejl] signatur-verifikation fejlede');
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // ─── Parse ───────────────────────────────────────────────────────────
  const parsed = parseFejlSvar(xml);
  if (!parsed) {
    logger.warn('[etl/svar/fejl] kunne ikke parse messageId fra payload');
    return new NextResponse('OK', { status: 200 }); // 200 så Tinglysning ikke retryer
  }

  // ─── Opdater anmeldelse ──────────────────────────────────────────────
  const client = getServiceClient();
  if (!client) {
    logger.error('[etl/svar/fejl] Supabase-klient ikke tilgængelig');
    return new NextResponse('Server error', { status: 500 });
  }

  try {
    const { error } = await client
      .from('tinglysning_anmeldelse')
      .update({
        status: 'fejl',
        error_message: parsed.fejlTekst,
        fejl_kode: parsed.fejlKode,
        fejl_modtaget_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
      })
      .eq('tinglysning_message_id', parsed.messageId);

    if (error) {
      logger.error('[etl/svar/fejl] DB update fejl', { error });
      // 500 → Tinglysning retryer = OK (transient DB-fejl kan hele sig)
      return new NextResponse('DB error', { status: 500 });
    }
  } catch (err) {
    logger.error('[etl/svar/fejl] uventet fejl', err);
    return new NextResponse('Server error', { status: 500 });
  }

  // ─── 200 OK med tomt body — Tinglysning's protokol-krav ──────────────
  return new NextResponse('', { status: 200 });
}
