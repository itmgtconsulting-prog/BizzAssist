/**
 * Unit-tests for 2 små utility-moduler:
 *  - appUrl.getAppUrl() — base-URL resolution (env + trailing-slash-strip)
 *  - certExpiry.checkCertExpiry() — PFX parsing + status-klassifikation
 *
 * BIZZ-599: Løft af lib-test-coverage. Små utilities uden eksisterende tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAppUrl } from '@/app/lib/appUrl';
import { checkCertExpiry } from '@/app/lib/certExpiry';

describe('getAppUrl', () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
  });

  it('returnerer produktions-fallback når env var mangler', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getAppUrl()).toBe('https://bizzassist.dk');
  });

  it('strippes trailing slash', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://test.example.dk/';
    expect(getAppUrl()).toBe('https://test.example.dk');
  });

  it('lader URL uden trailing slash stå uændret', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://custom.bizzassist.dk';
    expect(getAppUrl()).toBe('https://custom.bizzassist.dk');
  });

  it('håndterer localhost uden trailing slash', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    expect(getAppUrl()).toBe('http://localhost:3000');
  });
});

describe('checkCertExpiry — status-klassifikation', () => {
  beforeEach(() => {
    // Isolér fra env så testen ikke afhænger af udvikler-lokale cert-stier
  });

  it('returnerer unknown når hverken path eller base64 er sat', () => {
    const result = checkCertExpiry('Test', '', '', '');
    expect(result.status).toBe('unknown');
    expect(result.expiresAt).toBeNull();
    expect(result.daysRemaining).toBeNull();
    expect(result.error).toBe('No certificate configured');
  });

  it('returnerer unknown (med parse-error) for invalid base64', () => {
    // Invalid base64-data — X509Certificate-konstruktøren kaster
    const result = checkCertExpiry('Invalid', '', 'bm90LWEtdmFsaWQtcGZ4', '');
    expect(result.status).toBe('unknown');
    expect(result.error).toBeTruthy();
  });

  it('returnerer unknown for ikke-eksisterende filsti', () => {
    const result = checkCertExpiry(
      'NonExistent',
      '/tmp/definitely-not-a-real-path-bizz.p12',
      '',
      ''
    );
    // fs.existsSync returnerer false → faller til "No certificate configured"
    expect(result.status).toBe('unknown');
  });

  it('bærer det angivne navn igennem uanset udfald', () => {
    const result = checkCertExpiry('MyCert', '', '', '');
    expect(result.name).toBe('MyCert');
  });
});
