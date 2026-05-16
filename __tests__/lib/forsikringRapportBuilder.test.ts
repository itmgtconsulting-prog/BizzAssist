/**
 * Unit tests for forsikring/rapportBuilder (BIZZ-1529).
 *
 * Verificerer at DOCX-bygger producerer en valid ZIP-fil (DOCX = ZIP+XML)
 * med korrekt struktur og indlejret data. Vi unzipper og inspicerer
 * word/document.xml for at bekræfte data-injection.
 */
import { describe, it, expect } from 'vitest';
import { buildGapRapportDocx, type GapRapportInput } from '@/app/lib/forsikring/rapportBuilder';

function mkInput(overrides: Partial<GapRapportInput> = {}): GapRapportInput {
  return {
    kundeNavn: 'Test Kunde ApS',
    analyse: {
      total_aktiver: 5,
      insured_count: 3,
      uninsured_count: 2,
      total_risk_score: 65,
      created_at: '2026-05-16T12:00:00Z',
    },
    aktiver: [
      {
        type: 'ejendom',
        label: 'Testvej 1',
        adresse: 'Testvej 1, 2100 København Ø',
        matched_policy_id: 'pol-1',
        match_score: 85,
      },
      {
        type: 'virksomhed',
        label: 'Test ApS',
        adresse: null,
        matched_policy_id: null,
        match_score: null,
      },
    ],
    policies: [
      {
        id: 'pol-1',
        policy_number: 'POL-12345',
        insurer_name: 'Test Forsikring',
        property_address: 'Testvej 1, 2100 København Ø',
        annual_premium_dkk: 15000,
        effective_to: '2027-01-01',
        sum_insured_dkk: 5000000,
      },
    ],
    gaps: [
      {
        policy_id: 'pol-1',
        severity: 'critical',
        title: 'Manglende areal-dækning',
        description: 'BBR-areal 250 m² men police dækker 200 m²',
        recommendation: 'Opdater police til faktisk areal',
      },
      {
        policy_id: 'pol-1',
        severity: 'warning',
        title: 'Lav forsikringssum',
        description: 'Forsikringssum under vurdering',
        recommendation: null,
      },
    ],
    ...overrides,
  };
}

async function unzipDocXml(buf: Buffer): Promise<string> {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip(buf);
  return zip.file('word/document.xml')?.asText() ?? '';
}

describe('buildGapRapportDocx', () => {
  it('returnerer Buffer indeholdende valid DOCX/ZIP signatur', async () => {
    const buf = await buildGapRapportDocx(mkInput());
    expect(Buffer.isBuffer(buf)).toBe(true);
    // DOCX = ZIP, første 4 bytes = PK\x03\x04
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  it('inkluderer kundenavn i document body', async () => {
    const buf = await buildGapRapportDocx(mkInput({ kundeNavn: 'Spændende A/S' }));
    const xml = await unzipDocXml(buf);
    expect(xml).toContain('Spændende A/S');
  });

  it('inkluderer KPI-tal fra analyse', async () => {
    const buf = await buildGapRapportDocx(
      mkInput({
        analyse: {
          total_aktiver: 17,
          insured_count: 12,
          uninsured_count: 5,
          total_risk_score: 73,
          created_at: '2026-05-16T12:00:00Z',
        },
      })
    );
    const xml = await unzipDocXml(buf);
    expect(xml).toContain('17'); // total
    expect(xml).toContain('12'); // insured
    expect(xml).toContain('5'); // uninsured
  });

  it('inkluderer alle policy_numbers', async () => {
    const buf = await buildGapRapportDocx(
      mkInput({
        policies: [
          {
            id: 'a',
            policy_number: 'POL-AAA',
            insurer_name: 'Ins-A',
            property_address: 'Adr 1',
            annual_premium_dkk: 1000,
            effective_to: '2027-01-01',
            sum_insured_dkk: 100000,
          },
          {
            id: 'b',
            policy_number: 'POL-BBB',
            insurer_name: 'Ins-B',
            property_address: null,
            annual_premium_dkk: null,
            effective_to: null,
            sum_insured_dkk: null,
          },
        ],
      })
    );
    const xml = await unzipDocXml(buf);
    expect(xml).toContain('POL-AAA');
    expect(xml).toContain('POL-BBB');
    expect(xml).toContain('Ins-A');
    expect(xml).toContain('Ins-B');
  });

  it('inkluderer gap-titler og severities', async () => {
    const buf = await buildGapRapportDocx(mkInput());
    const xml = await unzipDocXml(buf);
    expect(xml).toContain('Manglende areal-dækning');
    expect(xml).toContain('Lav forsikringssum');
  });

  it('XML-escaper specielle tegn i kundenavn (sikkerhed)', async () => {
    const evil = '<script>alert(1)</script> & "quoted"';
    const buf = await buildGapRapportDocx(mkInput({ kundeNavn: evil }));
    const xml = await unzipDocXml(buf);
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
  });

  it('håndterer tom aktiver-liste uden crash', async () => {
    const buf = await buildGapRapportDocx(mkInput({ aktiver: [] }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    const xml = await unzipDocXml(buf);
    expect(xml.length).toBeGreaterThan(100);
  });

  it('håndterer tom gaps-liste uden crash', async () => {
    const buf = await buildGapRapportDocx(mkInput({ gaps: [] }));
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('formaterer DKK-tal med kr-suffix', async () => {
    const buf = await buildGapRapportDocx(
      mkInput({
        policies: [
          {
            id: 'p',
            policy_number: 'P1',
            insurer_name: 'I',
            property_address: null,
            annual_premium_dkk: 15000,
            effective_to: null,
            sum_insured_dkk: 1500000,
          },
        ],
      })
    );
    const xml = await unzipDocXml(buf);
    // Locale-data varierer på CI; tjek bare at 'kr' suffix + tal-cifre er til stede
    expect(xml).toContain(' kr');
    expect(xml).toMatch(/15[.,\s]?000/);
  });

  it('håndterer ugyldig dato graceful (returnerer iso-strengen)', async () => {
    const buf = await buildGapRapportDocx(
      mkInput({
        policies: [
          {
            id: 'p',
            policy_number: 'P1',
            insurer_name: 'I',
            property_address: null,
            annual_premium_dkk: null,
            effective_to: 'not-a-date',
            sum_insured_dkk: null,
          },
        ],
      })
    );
    const xml = await unzipDocXml(buf);
    expect(xml).toContain('not-a-date');
  });
});
