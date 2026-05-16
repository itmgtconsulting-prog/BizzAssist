/**
 * Unit tests for /api/etl/svar/brugerformular route (BIZZ-1521).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/app/lib/s2sClient', () => ({ verifyXmlSignature: vi.fn() }));

import { createClient } from '@supabase/supabase-js';
import { verifyXmlSignature } from '@/app/lib/s2sClient';
import { POST } from '@/app/api/etl/svar/brugerformular/route';
import { _resetCallbackClientForTests } from '@/app/lib/etl/callbackHelpers';

const mockVerify = vi.mocked(verifyXmlSignature);
const mockCreate = vi.mocked(createClient);

function makeReq(body: string): NextRequest {
  return new NextRequest('http://localhost/api/etl/svar/brugerformular', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/xml' },
  });
}

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<BrugerformularSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/">
  <MessageID>uuid:bform-001</MessageID>
  <FormularID>form-12345</FormularID>
  <FormularType>underskrift-bekraeftelse</FormularType>
  <Kundereference>uuid:anmeldelse-ref-99</Kundereference>
  <Felter>
    <Felt><Navn>NemId</Navn><Vaerdi>1234567890</Vaerdi></Felt>
    <Felt><Navn>UnderskrevetTid</Navn><Vaerdi>2026-05-16T14:00:00Z</Vaerdi></Felt>
  </Felter>
</BrugerformularSvar>`;

beforeEach(() => {
  mockVerify.mockReset();
  mockCreate.mockReset();
  _resetCallbackClientForTests();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srv';
  process.env.TINGLYSNING_RESPONSE_TRUST_CERT =
    '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n';
});

describe('POST /api/etl/svar/brugerformular', () => {
  it('happy path: parser felter + insert + 200', async () => {
    mockVerify.mockReturnValue(true);
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'anmeldelse-uuid' } });
    const eq1 = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
      if (table === 'tinglysning_anmeldelse') return { select };
      return { insert };
    });
    mockCreate.mockReturnValue({ from } as never);

    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        anmeldelse_id: 'anmeldelse-uuid',
        formular_id: 'form-12345',
        formular_type: 'underskrift-bekraeftelse',
        kundereference: 'uuid:anmeldelse-ref-99',
        form_data: { NemId: '1234567890', UnderskrevetTid: '2026-05-16T14:00:00Z' },
        tinglysning_message_id: 'uuid:bform-001',
      })
    );
  });

  it('401 ved invalid signatur', async () => {
    mockVerify.mockReturnValue(false);
    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(401);
  });

  it('500 hvis trust-cert mangler', async () => {
    delete process.env.TINGLYSNING_RESPONSE_TRUST_CERT;
    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(500);
  });

  it('200 ved uparseable (mangler MessageID)', async () => {
    mockVerify.mockReturnValue(true);
    const insert = vi.fn();
    const from = vi.fn().mockReturnValue({ insert });
    mockCreate.mockReturnValue({ from } as never);

    const res = await POST(
      makeReq(
        '<BrugerformularSvar xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/"></BrugerformularSvar>'
      )
    );
    expect(res.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });

  it('200 ved duplicate (idempotent replay)', async () => {
    mockVerify.mockReturnValue(true);
    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const eq1 = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const insert = vi.fn().mockResolvedValue({ error: { code: '23505' } });
    const from = vi.fn((table: string) =>
      table === 'tinglysning_anmeldelse' ? { select } : { insert }
    );
    mockCreate.mockReturnValue({ from } as never);

    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(200);
  });

  it('insertes med anmeldelse_id=null hvis kundereference ikke matcher', async () => {
    mockVerify.mockReturnValue(true);
    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const eq1 = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) =>
      table === 'tinglysning_anmeldelse' ? { select } : { insert }
    );
    mockCreate.mockReturnValue({ from } as never);

    const res = await POST(makeReq(SAMPLE_XML));
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ anmeldelse_id: null }));
  });
});
