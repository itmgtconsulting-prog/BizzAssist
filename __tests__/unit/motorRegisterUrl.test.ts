/**
 * BIZZ-2144: Tests for motorRegisterUrl — link til motorregisterets åbne opslag.
 */
import { describe, it, expect } from 'vitest';
import { motorRegisterUrl } from '@/app/dashboard/forsikring/ForsikringPageClient';

describe('motorRegisterUrl', () => {
  it('bygger en absolut motorregister-URL med reg.nr som query', () => {
    const url = motorRegisterUrl('CE18728');
    expect(url).toContain('https://motorregister.skat.dk/');
    expect(url).toContain('CE18728');
  });

  it('normaliserer mellemrum og store/små bogstaver', () => {
    expect(motorRegisterUrl('ce 18 728')).toContain('CE18728');
  });

  it('URL-encoder reg.nr', () => {
    // Reg.nr indeholder normalt kun [A-Z0-9], men sikr at output er valid URL
    expect(() => new URL(motorRegisterUrl('AB12345'))).not.toThrow();
  });
});
