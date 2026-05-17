/**
 * POST /api/etl/svar/underskriftmappe — UnderskriftmappeSvar callback fra Tinglysning.
 *
 * Tinglysning sender denne callback når en bruger har underskrevet (eller
 * afvist) en dokument-mappe via NemID/MitID. Vi opdaterer den koblede
 * anmeldelse's status baseret på underskrift-resultat.
 *
 * Status-mapning:
 *   - "underskrevet" / "godkendt" → status = 'submitted' (klar til Tinglysning)
 *   - "afvist" → status = 'cancelled'
 *   - "udløbet" → status = 'cancelled' (timeout på underskrift-vindue)
 *
 * Notifikation til ejer (in-app + email) er deferred til separat ticket —
 * brugeren kan polle status via /api/tinglysning/anmeldelse/[id] indtil da.
 *
 * @module api/etl/svar/underskriftmappe
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/app/lib/logger';
import {
  ackResponse,
  getCallbackServiceClient,
  verifyAndReadCallbackBody,
} from '@/app/lib/etl/callbackHelpers';

export const runtime = 'nodejs';

interface ParsedUnderskriftmappe {
  messageId: string;
  /** Reference til anmeldelse (typisk vores tinglysning_message_id) */
  mappeReference: string;
  /** Underskrift-resultat: 'underskrevet' | 'afvist' | 'udloebet' | ... */
  status: string;
  /** Tidspunkt for underskrift */
  underskrevet_at: string | null;
}

function parseUnderskriftmappeSvar(xml: string): ParsedUnderskriftmappe | null {
  const messageId = xml.match(/<MessageID>([^<]+)<\/MessageID>/i)?.[1] ?? null;
  if (!messageId) return null;

  const mappeReference =
    xml.match(/<MappeReference>([^<]+)<\/MappeReference>/i)?.[1] ??
    xml.match(/<Kundereference>([^<]+)<\/Kundereference>/i)?.[1] ??
    null;

  const status =
    xml.match(/<UnderskriftStatus>([^<]+)<\/UnderskriftStatus>/i)?.[1] ??
    xml.match(/<Status>([^<]+)<\/Status>/i)?.[1] ??
    null;

  const underskrevet_at =
    xml.match(/<UnderskrevetTid>([^<]+)<\/UnderskrevetTid>/i)?.[1] ??
    xml.match(/<TidsStempel>([^<]+)<\/TidsStempel>/i)?.[1] ??
    null;

  if (!mappeReference || !status) return null;
  return { messageId, mappeReference, status, underskrevet_at };
}

/**
 * Map Tinglysning's underskrift-status til vores anmeldelse-status enum.
 */
function mapToAnmeldelseStatus(underskriftStatus: string): {
  status: 'submitted' | 'cancelled' | null;
  reason: string | null;
} {
  const norm = underskriftStatus.toLowerCase().trim();
  if (norm === 'underskrevet' || norm === 'godkendt' || norm === 'gennemfoert') {
    return { status: 'submitted', reason: null };
  }
  if (norm === 'afvist' || norm === 'rejected') {
    return { status: 'cancelled', reason: 'Bruger afviste underskrift' };
  }
  if (norm === 'udloebet' || norm === 'udløbet' || norm === 'expired') {
    return { status: 'cancelled', reason: 'Underskrift-vindue udløb' };
  }
  return { status: null, reason: null };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const entry = await verifyAndReadCallbackBody(request, 'etl/svar/underskriftmappe');
  if (!entry.ok) return entry.response;

  const parsed = parseUnderskriftmappeSvar(entry.xml);
  if (!parsed) {
    logger.warn('[etl/svar/underskriftmappe] kunne ikke parse callback');
    return new NextResponse('OK', { status: 200 });
  }

  const mapping = mapToAnmeldelseStatus(parsed.status);
  if (!mapping.status) {
    logger.warn('[etl/svar/underskriftmappe] ukendt status', { status: parsed.status });
    return ackResponse(); // 200 — undgår retry-storm
  }

  const client = getCallbackServiceClient();
  if (!client) {
    logger.error('[etl/svar/underskriftmappe] Supabase-klient utilgængelig');
    return new NextResponse('Server error', { status: 500 });
  }

  try {
    const updates: Record<string, unknown> = {
      status: mapping.status,
    };
    if (mapping.reason) updates.error_message = mapping.reason;
    if (mapping.status === 'submitted')
      updates.submitted_at = parsed.underskrevet_at ?? new Date().toISOString();
    if (mapping.status === 'cancelled') updates.resolved_at = new Date().toISOString();

    const { error } = await client
      .from('tinglysning_anmeldelse')
      .update(updates)
      .eq('tinglysning_message_id', parsed.mappeReference);

    if (error) {
      logger.error('[etl/svar/underskriftmappe] DB update fejl', { error });
      return new NextResponse('DB error', { status: 500 });
    }
  } catch (err) {
    logger.error('[etl/svar/underskriftmappe] uventet fejl', err);
    return new NextResponse('Server error', { status: 500 });
  }

  return ackResponse();
}
