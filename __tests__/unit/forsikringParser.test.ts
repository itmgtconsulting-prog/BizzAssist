/**
 * Unit tests for app/lib/forsikring/parser.ts.
 *
 * Dækker:
 *   - stripMarkdownFences: ren JSON, ```json blok, ``` blok, kun whitespace
 *   - ParsedPolicySchema: validering af korrekte og ukorrekte JSON-output
 */
import { describe, it, expect } from 'vitest';
import { stripMarkdownFences, canParseAsText } from '@/app/lib/forsikring/jsonHelpers';
import { oversigtEntryMatchesPolicy } from '@/app/lib/forsikring/parser';
import {
  COVERAGE_CODES,
  COVERAGE_LABELS_DA,
  ParsedCoverageSchema,
  ParsedPolicySchema,
} from '@/app/lib/forsikring/types';

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

describe('canParseAsText', () => {
  it('returnerer true for PDF', () => {
    expect(canParseAsText('pdf')).toBe(true);
  });

  it('returnerer true for Office-formater', () => {
    expect(canParseAsText('docx')).toBe(true);
    expect(canParseAsText('xlsx')).toBe(true);
    expect(canParseAsText('pptx')).toBe(true);
  });

  it('returnerer true for plain text-familien', () => {
    expect(canParseAsText('txt')).toBe(true);
    expect(canParseAsText('csv')).toBe(true);
    expect(canParseAsText('json')).toBe(true);
    expect(canParseAsText('html')).toBe(true);
  });

  it('returnerer true for email', () => {
    expect(canParseAsText('eml')).toBe(true);
  });

  it('returnerer false for billeder (skal bruge vision)', () => {
    expect(canParseAsText('image')).toBe(false);
  });

  it('returnerer false for ukendt filtype', () => {
    expect(canParseAsText('msg')).toBe(false);
  });
});

// BIZZ-2081: Salvage af afkortet oversigt-JSON
import { salvageTruncatedOversigt } from '@/app/lib/forsikring/jsonHelpers';

describe('salvageTruncatedOversigt', () => {
  const policy = (n: number) =>
    `{"policy_number":"P${n}","insurer_name":"Tryg","coverages":[{"coverage_code":"brand_el","is_covered":true}]}`;

  it('redder komplette policer fra afkortet JSON', () => {
    const truncated = `{"policies":[${policy(1)},${policy(2)},{"policy_number":"P3","insurer_na`;
    const result = salvageTruncatedOversigt(truncated);
    expect(result).not.toBeNull();
    expect(result!.policies).toHaveLength(2);
    expect((result!.policies[0] as { policy_number: string }).policy_number).toBe('P1');
    expect(result!.notes).toContain('for lang');
  });

  it('håndterer afkortning midt i en streng med escapes og brackets', () => {
    const truncated = `{"policies":[${policy(1)}],"broker_name":"RTM \\"a{b[c`;
    // policies-arrayet er lukket korrekt — depth går under 0 ved ']' og scanningen stopper
    const result = salvageTruncatedOversigt(truncated);
    expect(result).not.toBeNull();
    expect(result!.policies).toHaveLength(1);
  });

  it('returnerer null når intet komplet objekt findes', () => {
    expect(salvageTruncatedOversigt('{"policies":[{"policy_number":"P1')).toBeNull();
  });

  it('returnerer null uden policies-array', () => {
    expect(salvageTruncatedOversigt('{"broker_name":"RTM"')).toBeNull();
  });

  it('ignorerer brackets inde i strenge', () => {
    const truncated = `{"policies":[{"policy_number":"P1","notes":"adresse {with} [brackets]"},{"poli`;
    const result = salvageTruncatedOversigt(truncated);
    expect(result).not.toBeNull();
    expect(result!.policies).toHaveLength(1);
  });
});

describe('oversigtEntryMatchesPolicy (BIZZ-2097)', () => {
  it('matcher når både adresse og forsikringstype er ens', () => {
    expect(
      oversigtEntryMatchesPolicy(
        { property_address: 'Hovedgaden 1', business_activity: 'Erhvervsansvar' },
        { property_address: 'Hovedgaden 1', insurance_type: 'Erhvervsansvar' }
      )
    ).toBe(true);
  });

  it('matcher IKKE adresseløse entries med forskellig forsikringstype (null === null bug)', () => {
    expect(
      oversigtEntryMatchesPolicy(
        { property_address: null, business_activity: 'Cyberforsikring' },
        { property_address: null, insurance_type: 'Netbankforsikring' }
      )
    ).toBe(false);
  });

  it('matcher IKKE når adressen er forskellig', () => {
    expect(
      oversigtEntryMatchesPolicy(
        { property_address: 'Hovedgaden 1', business_activity: 'Bygningsforsikring' },
        { property_address: 'Hovedgaden 2', insurance_type: 'Bygningsforsikring' }
      )
    ).toBe(false);
  });

  it('normaliserer case og whitespace', () => {
    expect(
      oversigtEntryMatchesPolicy(
        { property_address: ' Hovedgaden 1 ', business_activity: 'cyberforsikring' },
        { property_address: 'hovedgaden 1', insurance_type: 'Cyberforsikring ' }
      )
    ).toBe(true);
  });

  it('behandler tom streng som null', () => {
    expect(
      oversigtEntryMatchesPolicy(
        { property_address: '', business_activity: 'Driftstab' },
        { property_address: null, insurance_type: 'Driftstab' }
      )
    ).toBe(true);
  });

  it('regression: 9 entries under samme aftalenr giver 9 policer (Topdanmark-mønster)', () => {
    // Simulerer oversigts-loopet: hver entry sammenlignes mod allerede oprettede
    // policer med samme aftalenummer — ingen må kollapses
    const entries = [
      { property_address: 'Roholmsvej 19', insurance_type: 'Bygningsforsikring' },
      { property_address: null, insurance_type: 'Erhvervsansvar' },
      { property_address: null, insurance_type: 'Cyberforsikring' },
      { property_address: null, insurance_type: 'Netbankforsikring' },
      { property_address: null, insurance_type: 'Driftstabsforsikring' },
      { property_address: null, insurance_type: 'Kriminalitetsforsikring' },
      { property_address: null, insurance_type: 'Løsøreforsikring' },
      { property_address: null, insurance_type: 'Transportforsikring' },
      { property_address: null, insurance_type: 'Arbejdsskadeforsikring' },
    ];
    const created: Array<{ property_address: string | null; business_activity: string | null }> =
      [];
    for (const entry of entries) {
      const existing = created.find((p) => oversigtEntryMatchesPolicy(p, entry));
      if (existing) continue;
      created.push({
        property_address: entry.property_address,
        business_activity: entry.insurance_type,
      });
    }
    expect(created).toHaveLength(9);
  });

  it('regression: identisk entry parses to gange → kun 1 police (dedup virker stadig)', () => {
    const policy = { property_address: null, business_activity: 'Cyberforsikring' };
    expect(
      oversigtEntryMatchesPolicy(policy, {
        property_address: null,
        insurance_type: 'Cyberforsikring',
      })
    ).toBe(true);
  });
});

// ─── BIZZ-2098: Erhvervs-taksonomi for dækningskoder ─────────────────

describe('COVERAGE_CODES erhvervs-taksonomi (BIZZ-2098)', () => {
  const erhvervskoder = [
    'loesoere',
    'indbrudstyveri',
    'ran_roeveri',
    'oprydning',
    'cyber',
    'cyberdriftstab',
    'notifikation',
    'netbank',
    'kriminalitet',
    'transport',
    'maskiner_itudstyr',
    'it_meromkostninger',
    'leverandoer_aftager',
  ] as const;

  it('indeholder alle nye erhvervskoder', () => {
    for (const code of erhvervskoder) {
      expect(COVERAGE_CODES).toContain(code);
    }
  });

  it('har en dansk label for hver kanonisk kode', () => {
    for (const code of COVERAGE_CODES) {
      expect(COVERAGE_LABELS_DA[code]).toBeTruthy();
    }
  });

  it('ParsedCoverageSchema accepterer cyber-dækning med sum og selvrisiko', () => {
    const result = ParsedCoverageSchema.safeParse({
      coverage_code: 'cyber',
      coverage_label: 'Cyber',
      is_covered: true,
      sum_dkk: 1116693,
      deductible_dkk: 25000,
    });
    expect(result.success).toBe(true);
  });

  it('ParsedCoverageSchema afviser ukendt kode', () => {
    const result = ParsedCoverageSchema.safeParse({
      coverage_code: 'rumrejseforsikring',
      coverage_label: 'Rumrejse',
      is_covered: true,
    });
    expect(result.success).toBe(false);
  });
});
