/**
 * Unit tests for app/lib/forsikring/parser.ts.
 *
 * Dækker:
 *   - stripMarkdownFences: ren JSON, ```json blok, ``` blok, kun whitespace
 *   - ParsedPolicySchema: validering af korrekte og ukorrekte JSON-output
 */
import { describe, it, expect } from 'vitest';
import { stripMarkdownFences } from '@/app/lib/forsikring/jsonHelpers';
import { ParsedPolicySchema } from '@/app/lib/forsikring/types';

describe('stripMarkdownFences', () => {
  it('returnerer ren JSON uændret', () => {
    expect(stripMarkdownFences('{"a":1}')).toBe('{"a":1}');
  });

  it('fjerner ```json prefix', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(stripMarkdownFences(raw)).toBe('{"a":1}');
  });

  it('fjerner bare ``` prefix', () => {
    const raw = '```\n{"a":1}\n```';
    expect(stripMarkdownFences(raw)).toBe('{"a":1}');
  });

  it('trimmer leading/trailing whitespace', () => {
    expect(stripMarkdownFences('   {"a":1}   ')).toBe('{"a":1}');
  });

  it('håndterer tom streng', () => {
    expect(stripMarkdownFences('')).toBe('');
  });

  it('håndterer kun fences', () => {
    expect(stripMarkdownFences('```\n```')).toBe('');
  });
});

describe('ParsedPolicySchema', () => {
  /** Minimum gyldig parsed policy */
  const validPolicy = {
    policy_number: '50143392',
    insurer_name: 'Alm. Brand Forsikring A/S',
    policyholder_name: 'Belvedere Ejendomme A/S',
    coverages: [
      {
        coverage_code: 'brand_el',
        coverage_label: 'Brand inkl. el-skade',
        is_covered: true,
      },
    ],
  };

  it('accepterer minimum gyldig policy', () => {
    const result = ParsedPolicySchema.safeParse(validPolicy);
    expect(result.success).toBe(true);
  });

  it('accepterer null/optional felter', () => {
    const result = ParsedPolicySchema.safeParse({
      ...validPolicy,
      insurer_cvr: null,
      broker_name: null,
      property_bfe: null,
    });
    expect(result.success).toBe(true);
  });

  it('afviser policy uden policy_number', () => {
    const { policy_number: _omit, ...rest } = validPolicy;
    void _omit;
    const result = ParsedPolicySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('afviser ukendt coverage_code', () => {
    const result = ParsedPolicySchema.safeParse({
      ...validPolicy,
      coverages: [
        {
          coverage_code: 'INVALID_CODE',
          coverage_label: 'Test',
          is_covered: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('afviser dato i forkert format', () => {
    const result = ParsedPolicySchema.safeParse({
      ...validPolicy,
      effective_from: '01-08-2022', // forkert: skal være YYYY-MM-DD
    });
    expect(result.success).toBe(false);
  });

  it('accepterer dato i YYYY-MM-DD format', () => {
    const result = ParsedPolicySchema.safeParse({
      ...validPolicy,
      effective_from: '2022-08-01',
      effective_to: '2028-03-31',
      main_renewal_date: '2026-04-01',
      policy_issued_date: '2022-07-08',
    });
    expect(result.success).toBe(true);
  });

  it('accepterer alle 5 forsikrings-former', () => {
    const forms = ['nyvaerdi', 'sum', 'f_risiko', 'nedrivning', 'uforsikret'] as const;
    for (const f of forms) {
      const result = ParsedPolicySchema.safeParse({ ...validPolicy, insurance_form: f });
      expect(result.success).toBe(true);
    }
  });

  it('afviser negative beløb', () => {
    const result = ParsedPolicySchema.safeParse({
      ...validPolicy,
      annual_premium_dkk: -1000,
    });
    expect(result.success).toBe(false);
  });

  it('afviser building_year_built i fremtiden', () => {
    const result = ParsedPolicySchema.safeParse({
      ...validPolicy,
      building_year_built: 2200,
    });
    expect(result.success).toBe(false);
  });

  it('accepterer eksplicit ekskluderede dækninger (is_covered=false)', () => {
    const result = ParsedPolicySchema.safeParse({
      ...validPolicy,
      coverages: [
        {
          coverage_code: 'brand_el',
          coverage_label: 'Brand',
          is_covered: true,
        },
        {
          coverage_code: 'glas',
          coverage_label: 'Glas',
          is_covered: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
