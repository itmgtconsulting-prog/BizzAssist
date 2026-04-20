/**
 * Unit-tests for companyInfo — central virksomhedsoplysnings-singleton.
 *
 * Dækker de computed getters (fullAddress, legalLine, legalLineHtml) samt
 * invariant-properties vi bruger i email-footers, PDF-generering og juridiske
 * sider. Hvis nogen ændrer firmanavn/CVR/adresse skal det ske bevidst — de her
 * tests fanger utilsigtede tekst-kampagne-regressions.
 *
 * BIZZ-599: Lib-tests for kritiske untested-filer.
 */

import { describe, it, expect } from 'vitest';
import { companyInfo } from '@/app/lib/companyInfo';

describe('companyInfo static fields', () => {
  it('har de forventede stamdata', () => {
    expect(companyInfo.name).toBe('Pecunia IT ApS');
    expect(companyInfo.cvr).toBe('44718502');
    expect(companyInfo.country).toBe('Denmark');
  });

  it('eksponerer alle email-endpoints på bizzassist-/pecuniait-domæner', () => {
    expect(companyInfo.supportEmail).toMatch(/@pecuniait\.com$/);
    expect(companyInfo.noreplyEmail).toMatch(/@bizzassist\.dk$/);
    expect(companyInfo.adminEmail).toMatch(/@bizzassist\.dk$/);
  });

  it('CVR er præcis 8 cifre', () => {
    expect(companyInfo.cvr).toMatch(/^\d{8}$/);
  });
});

describe('companyInfo.fullAddress', () => {
  it('kombinerer address + postalCode + city', () => {
    expect(companyInfo.fullAddress).toBe('Søbyvej 11, 2650 Hvidovre');
  });
});

describe('companyInfo.legalLine', () => {
  it('inkluderer brand + firma + adresse + CVR i korrekt rækkefølge', () => {
    expect(companyInfo.legalLine).toBe(
      'BizzAssist — Pecunia IT ApS — Søbyvej 11, 2650 Hvidovre — CVR 44718502'
    );
  });

  it('bruger em-dash (ikke bindestreg) som separator', () => {
    // Unicode U+2014 — email-spec bruger em-dash for juridisk læsbarhed.
    const parts = companyInfo.legalLine.split(' — ');
    expect(parts).toHaveLength(4);
  });
});

describe('companyInfo.legalLineHtml', () => {
  it('HTML-encoder ø-tegnet i "Søbyvej" til &oslash;', () => {
    expect(companyInfo.legalLineHtml).toContain('S&oslash;byvej 11');
    expect(companyInfo.legalLineHtml).not.toContain('Søbyvej 11');
  });

  it('bruger HTML entities (&mdash;) i stedet for unicode em-dash', () => {
    expect(companyInfo.legalLineHtml).toContain('&mdash;');
    // Raw em-dash er udeladt fordi email-klienter håndterer &mdash; mere ens.
    expect(companyInfo.legalLineHtml).not.toContain(' — ');
  });

  it('bevarer CVR-feltet uændret', () => {
    expect(companyInfo.legalLineHtml).toContain('CVR 44718502');
  });
});

describe('companyInfo is immutable via "as const"', () => {
  it('kan ikke re-assignes (TypeScript enforcement — runtime sanity-check)', () => {
    // "as const"-assertion bør give Object.isFrozen-lignende adfærd TypeScript-
    // side; runtime er objektet stadig mutable, men vi verificerer at
    // centrale felter ikke er undefined (fanger hypothetic accidental delete).
    const required = ['name', 'cvr', 'supportEmail', 'noreplyEmail', 'adminEmail'] as const;
    for (const k of required) {
      expect(companyInfo[k]).toBeTruthy();
    }
  });
});
