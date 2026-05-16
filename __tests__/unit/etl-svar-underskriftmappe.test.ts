/**
 * Unit tests for /api/etl/svar/underskriftmappe route (BIZZ-1523).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/app/lib/s2sClient', () => ({ verifyXmlSignature: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import { verifyXmlSignature } from '@/app/lib/s2sClient';
import { POST } from '@/app/api/etl/svar/underskriftmappe/route';
import { _resetCallbackClientForTests } from '@/app/lib/etl/callbackHelpers';

const mockVerify = vi.mocked(verifyXmlSignature);
const mockCreate = vi.mocked(createClient);

function makeReq(body: string): NextRequest {
  return new NextRequest('http://localhost/api/etl/svar/underskriftmappe', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/xml' },
  });
}

function makeUpdateClient(updateResult: { error: unknown } = { error: null }) {
  const eq = vi.fn().mockResolvedValue(updateResult);
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  return { client: { from }, from, update, eq };
}

const signedXml = (status: string, ts = '2026-05-16T15:00:00Z') => `<?xml version="1.0"?>
<UnderskriftmappeSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/">
  <MessageID>uuid:usk-${status}</MessageID>
  <MappeReference>uuid:anmeldelse-77</MappeReference>
  <UnderskriftStatus>${status}</UnderskriftStatus>
  <UnderskrevetTid>${ts}</UnderskrevetTid>
</UnderskriftmappeSvar>`;

beforeEach(() => {
  mockVerify.mockReset();
  mockCreate.mockReset();
  _resetCallbackClientForTests();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srv';
  process.env.TINGLYSNING_RESPONSE_TRUST_CERT =
    '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n';
});

describe('POST /api/etl/svar/underskriftmappe', () => {
  it('happy path "underskrevet" mapper til submitted + submitted_at', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeUpdateClient();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(signedXml('underskrevet')));
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'submitted',
        submitted_at: '2026-05-16T15:00:00Z',
      })
    );
    expect(db.eq).toHaveBeenCalledWith('tinglysning_message_id', 'uuid:anmeldelse-77');
  });

  it('"afvist" mapper til cancelled med reason', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeUpdateClient();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(signedXml('afvist')));
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'cancelled',
        error_message: 'Bruger afviste underskrift',
      })
    );
  });

  it('"udloebet" mapper til cancelled med timeout reason', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeUpdateClient();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(signedXml('udloebet')));
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'cancelled',
        error_message: 'Underskrift-vindue udløb',
      })
    );
  });

  it('ukendt status: 200 OK uden DB-update', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeUpdateClient();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(signedXml('mysteriestatus')));
    expect(res.status).toBe(200);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('401 ved invalid signatur', async () => {
    mockVerify.mockReturnValue(false);
    const db = makeUpdateClient();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(signedXml('underskrevet')));
    expect(res.status).toBe(401);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('500 ved DB-fejl', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeUpdateClient({ error: { code: 'XX000' } });
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(signedXml('underskrevet')));
    expect(res.status).toBe(500);
  });

  it('200 ved manglende MappeReference', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeUpdateClient();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(
      makeReq(
        '<UnderskriftmappeSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/"><MessageID>uuid:x</MessageID></UnderskriftmappeSvar>'
      )
    );
    expect(res.status).toBe(200);
    expect(db.update).not.toHaveBeenCalled();
  });
});
