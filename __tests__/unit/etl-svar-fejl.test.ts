/**
 * Unit tests for /api/etl/svar/fejl route (BIZZ-1522).
 *
 * Dækker happy-path (verified XML → DB update → 200), signatur-fejl (401),
 * misconfigured trust cert (500), tom body (400), uparseable payload (200
 * for at undgå retry-storm).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies før import af route
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/app/lib/s2sClient', () => ({ verifyXmlSignature: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import { verifyXmlSignature } from '@/app/lib/s2sClient';
import { POST } from '@/app/api/etl/svar/fejl/route';

const mockVerify = vi.mocked(verifyXmlSignature);
const mockCreate = vi.mocked(createClient);

function makeReq(body: string): NextRequest {
  return new NextRequest('http://localhost/api/etl/svar/fejl', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/xml' },
  });
}

function makeDb(updateResult: { error: unknown } = { error: null }) {
  const eq = vi.fn().mockResolvedValue(updateResult);
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  return { client: { from }, from, update, eq };
}

const SAMPLE_FEJL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FejlSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/">
  <MessageID>uuid:00000000-1111-2222-3333-444444444444</MessageID>
  <FejlKode>VAL-001</FejlKode>
  <FejlTekst>Signatur mangler i request body</FejlTekst>
</FejlSvar>`;

beforeEach(() => {
  mockVerify.mockReset();
  mockCreate.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-srv';
  process.env.TINGLYSNING_RESPONSE_TRUST_CERT =
    '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n';
});

describe('POST /api/etl/svar/fejl', () => {
  it('happy path: verificerer + opdaterer DB + 200 OK med tomt body', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(SAMPLE_FEJL_XML));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');

    expect(db.from).toHaveBeenCalledWith('tinglysning_anmeldelse');
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'fejl',
        error_message: 'Signatur mangler i request body',
        fejl_kode: 'VAL-001',
      })
    );
    expect(db.eq).toHaveBeenCalledWith(
      'tinglysning_message_id',
      'uuid:00000000-1111-2222-3333-444444444444'
    );
  });

  it('returnerer 401 ved invalid signatur (ingen DB-kald)', async () => {
    mockVerify.mockReturnValue(false);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(SAMPLE_FEJL_XML));
    expect(res.status).toBe(401);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returnerer 500 hvis TINGLYSNING_RESPONSE_TRUST_CERT mangler', async () => {
    delete process.env.TINGLYSNING_RESPONSE_TRUST_CERT;
    const res = await POST(makeReq(SAMPLE_FEJL_XML));
    expect(res.status).toBe(500);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('returnerer 400 ved tomt body', async () => {
    const res = await POST(makeReq(''));
    expect(res.status).toBe(400);
  });

  it('returnerer 200 ved uparseable payload (undgår retry-storm)', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(
      makeReq(
        '<FejlSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/"></FejlSvar>'
      )
    );
    expect(res.status).toBe(200);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returnerer 500 ved DB-fejl (Tinglysning retryer = transient OK)', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb({ error: new Error('connection refused') });
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(SAMPLE_FEJL_XML));
    expect(res.status).toBe(500);
  });

  it('parser SOAP-fault format (faultcode/faultstring)', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const soapFault = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Client</faultcode>
      <faultstring>Manglende eller ugyldig signatur</faultstring>
    </soap:Fault>
  </soap:Body>
  <Identifikator>uuid:abc-123</Identifikator>
</soap:Envelope>`;

    const res = await POST(makeReq(soapFault));
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'fejl',
        error_message: 'Manglende eller ugyldig signatur',
        fejl_kode: 'soap:Client',
      })
    );
  });
});
