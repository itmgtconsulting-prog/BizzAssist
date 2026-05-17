/**
 * POST /api/etl/svar/abonnement — AbonnementSvar callback fra Tinglysning.
 *
 * Tinglysning sender denne callback når en abonneret ejendom har en
 * ændring (tinglyst skøde, ny haftelse, servitut osv). Vi persisterer
 * eventet i `public.foelg_ejendom_event` så UI'en kan vise
 * ændringshistorik + notificere brugeren via NotifikationsDropdown.
 *
 * Flow:
 *   1. Verificer XMLDSig-signatur mod TINGLYSNING_RESPONSE_TRUST_CERT
 *      (afviser 401 ved invalid)
 *   2. Parse <ObjektUUID>, <AendringType>, <AendringTid>, <Kundereference>,
 *      <MessageID>
 *   3. INSERT i foelg_ejendom_event — UNIQUE message_id sikrer idempotency
 *      (DUPLICATE_KEY = 200 OK, ingen retry needed)
 *   4. Respond 200 OK med tomt body
 *
 * Sikkerhed:
 *   - Signatur-verifikation ER tilstrækkelig (vi stoler ikke på IP alene,
 *     selvom IP-whitelist på Hetzner-proxy giver defense-in-depth)
 *   - Tenant/user resolves fra kundereference (BFE) via foelg_ejendom tabel
 *     (skal bygges separat hvis ikke allerede til stede — pt sætter vi
 *     tenant/user til NULL og overlader til UI at filtrere efter objekt_uuid)
 *
 * @module api/etl/svar/abonnement
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyXmlSignature } from '@/app/lib/s2sClient';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

/** Parsed payload-shape */
interface ParsedAbonnement {
  messageId: string;
  objektUuid: string;
  aendringType: string;
  aendringTid: string;
  kundereference: string | null;
}

/** Tolerant regex-parser — XML-strukturen er stabil og signatur-verificeret */
function parseAbonnementSvar(xml: string): ParsedAbonnement | null {
  const messageId = xml.match(/<MessageID>([^<]+)<\/MessageID>/i)?.[1] ?? null;
  const objektUuid =
    xml.match(/<ObjektUUID>([^<]+)<\/ObjektUUID>/i)?.[1] ??
    xml.match(/<ObjektUuid>([^<]+)<\/ObjektUuid>/i)?.[1] ??
    null;
  const aendringType =
    xml.match(/<AendringType>([^<]+)<\/AendringType>/i)?.[1] ??
    xml.match(/<HaendelsesType>([^<]+)<\/HaendelsesType>/i)?.[1] ??
    null;
  const aendringTid =
    xml.match(/<AendringTid>([^<]+)<\/AendringTid>/i)?.[1] ??
    xml.match(/<TinglystTid>([^<]+)<\/TinglystTid>/i)?.[1] ??
    null;
  const kundereference = xml.match(/<Kundereference>([^<]+)<\/Kundereference>/i)?.[1] ?? null;

  if (!messageId || !objektUuid || !aendringType || !aendringTid) {
    return null;
  }
  return { messageId, objektUuid, aendringType, aendringTid, kundereference };
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * POST handler — verify + parse + persist + 200.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let xml: string;
  try {
    xml = await request.text();
  } catch (err) {
    logger.warn('[etl/svar/abonnement] body-læsning fejl', err);
    return new NextResponse('Bad Request', { status: 400 });
  }
  if (!xml || xml.length < 10) {
    return new NextResponse('Empty body', { status: 400 });
  }

  const trustedCert = process.env.TINGLYSNING_RESPONSE_TRUST_CERT;
  if (!trustedCert) {
    logger.error('[etl/svar/abonnement] TINGLYSNING_RESPONSE_TRUST_CERT mangler');
    return new NextResponse('Server misconfigured', { status: 500 });
  }
  if (!verifyXmlSignature(xml, trustedCert)) {
    logger.warn('[etl/svar/abonnement] signatur-verifikation fejlede');
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const parsed = parseAbonnementSvar(xml);
  if (!parsed) {
    logger.warn('[etl/svar/abonnement] kunne ikke parse callback');
    // 200 så Tinglysning ikke retryer (deterministisk parse-fejl)
    return new NextResponse('OK', { status: 200 });
  }

  const client = getServiceClient();
  if (!client) {
    logger.error('[etl/svar/abonnement] Supabase-klient utilgængelig');
    return new NextResponse('Server error', { status: 500 });
  }

  try {
    const { error } = await client.from('foelg_ejendom_event').insert({
      objekt_uuid: parsed.objektUuid,
      aendring_type: parsed.aendringType,
      aendring_tid: parsed.aendringTid,
      kundereference: parsed.kundereference,
      tinglysning_message_id: parsed.messageId,
      raw_xml: xml,
    });

    if (error) {
      // Postgres unique-violation code 23505 = idempotent replay → 200
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        return new NextResponse('', { status: 200 });
      }
      logger.error('[etl/svar/abonnement] DB insert fejl', { error });
      return new NextResponse('DB error', { status: 500 });
    }
  } catch (err) {
    logger.error('[etl/svar/abonnement] uventet fejl', err);
    return new NextResponse('Server error', { status: 500 });
  }

  return new NextResponse('', { status: 200 });
}
