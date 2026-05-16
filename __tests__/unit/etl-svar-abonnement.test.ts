/**
 * Unit tests for /api/etl/svar/abonnement route (BIZZ-1520).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/app/lib/s2sClient', () => ({ verifyXmlSignature: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import { verifyXmlSignature } from '@/app/lib/s2sClient';
import { POST } from '@/app/api/etl/svar/abonnement/route';

const mockVerify = vi.mocked(verifyXmlSignature);
const mockCreate = vi.mocked(createClient);

function makeReq(body: string): NextRequest {
  return new NextRequest('http://localhost/api/etl/svar/abonnement', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/xml' },
  });
}

function makeDb(insertResult: { error: unknown } = { error: null }) {
  const insert = vi.fn().mockResolvedValue(insertResult);
  const from = vi.fn().mockReturnValue({ insert });
  return { client: { from }, from, insert };
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AbonnementSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/">
  <MessageID>uuid:abc-123-456</MessageID>
  <ObjektUUID>obj-100000001</ObjektUUID>
  <AendringType>Tinglyst</AendringType>
  <AendringTid>2026-05-16T12:00:00Z</AendringTid>
  <Kundereference>BFE:100000001</Kundereference>
</AbonnementSvar>`;

beforeEach(() => {
  mockVerify.mockReset();
  mockCreate.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srv';
  process.env.TINGLYSNING_RESPONSE_TRUST_CERT =
    '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n';
});

describe('POST /api/etl/svar/abonnement', () => {
  it('happy path: verify + insert + 200 tomt body', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(db.from).toHaveBeenCalledWith('foelg_ejendom_event');
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        objekt_uuid: 'obj-100000001',
        aendring_type: 'Tinglyst',
        aendring_tid: '2026-05-16T12:00:00Z',
        kundereference: 'BFE:100000001',
        tinglysning_message_id: 'uuid:abc-123-456',
      })
    );
  });

  it('401 ved invalid signatur', async () => {
    mockVerify.mockReturnValue(false);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(401);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('500 hvis trust-cert mangler', async () => {
    delete process.env.TINGLYSNING_RESPONSE_TRUST_CERT;
    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(500);
  });

  it('400 ved tomt body', async () => {
    const res = await POST(makeReq(''));
    expect(res.status).toBe(400);
  });

  it('200 ved uparseable payload (undgår retry-storm)', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(
      makeReq(
        '<AbonnementSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/"></AbonnementSvar>'
      )
    );
    expect(res.status).toBe(200);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('200 ved duplicate (Postgres unique-violation = idempotent replay)', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb({ error: { code: '23505', message: 'duplicate key' } });
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(200);
  });

  it('500 ved generel DB-fejl (transient — Tinglysning retryer)', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb({ error: { code: 'XX000', message: 'connection refused' } });
    mockCreate.mockReturnValue(db.client as never);

    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(500);
  });

  it('accepterer alternative tag-navne (HaendelsesType, TinglystTid, ObjektUuid)', async () => {
    mockVerify.mockReturnValue(true);
    const db = makeDb();
    mockCreate.mockReturnValue(db.client as never);

    const alt = `<?xml version="1.0"?>
<AbonnementSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/">
  <MessageID>uuid:alt-456</MessageID>
  <ObjektUuid>obj-200</ObjektUuid>
  <HaendelsesType>Aflyst</HaendelsesType>
  <TinglystTid>2026-05-16T13:00:00Z</TinglystTid>
</AbonnementSvar>`;

    const res = await POST(makeReq(alt));
    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        objekt_uuid: 'obj-200',
        aendring_type: 'Aflyst',
        kundereference: null,
      })
    );
  });
});
