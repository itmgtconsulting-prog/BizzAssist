/**
 * Unit tests for forsikring/crossChecks pure detectors (BIZZ-1529).
 *
 * Fokus på de pure functions der ikke kræver external fetch-mocks:
 *   - detectKlyngerisiko (geografisk koncentration)
 *   - detectRestaurantKrav (branche-tjekliste)
 *   - detectAnbefalinger (D&O/Cyber/Driftstab)
 *
 * runBbr/Tinglysning/VurCrossCheck kører fetch mod interne routes; de
 * dækkes af integration tests i separat run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectKlyngerisiko,
  detectRestaurantKrav,
  detectAnbefalinger,
  runBbrCrossCheck,
  runTinglysningCrossCheck,
  runVurCrossCheck,
} from '@/app/lib/forsikring/crossChecks';
import type { Aktiv } from '@/app/lib/forsikring/koncernWalk';
import type { MatchResult } from '@/app/lib/forsikring/assetMatcher';

// Helper — minimal policy-shape for at unblocke type-systemet
type BestMatch = NonNullable<MatchResult['bestMatch']>;
function mkPolicy(over: { policy?: Partial<BestMatch['policy']> } = {}): BestMatch {
  return {
    score: 100,
    policy: {
      id: 'pol-1',
      sum_insured_dkk: 1_000_000,
      property_address: null,
      business_activity: null,
      building_use: null,
      raw_metadata: null,
      ...(over.policy ?? {}),
    } as BestMatch['policy'],
  };
}

function mkMatch(aktiv: Partial<Aktiv>, best: MatchResult['bestMatch'] | null): MatchResult {
  return {
    aktiv: { type: 'ejendom', label: 'test', ...aktiv } as Aktiv,
    bestMatch: best,
    candidates: best ? [best] : [],
  };
}

// ─── Async runners (BBR / Tinglysning / VUR) ────────────────────────────────

describe('runTinglysningCrossCheck', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('flagger GAP-102 hvis hæftelser overstiger forsikringssum', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ haeftelser: [{ beloeb: 10_000_000 }, { beloeb: 2_000_000 }] }),
          { status: 200 }
        )
      ) as never;
    const matches: MatchResult[] = [
      mkMatch(
        { type: 'ejendom', bfe: 100 },
        mkPolicy({ policy: { id: 'p1', sum_insured_dkk: 5_000_000 } as never })
      ),
    ];
    const r = await runTinglysningCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].check_id).toBe('GAP-102');
    expect(r.haeftelserByBfe.get(100)).toBe(12_000_000);
  });

  it('ingen gap hvis hæftelser < forsikringssum (men gemmer i map)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ haeftelser: [{ beloeb: 1_000_000 }] }), { status: 200 })
      ) as never;
    const matches: MatchResult[] = [
      mkMatch(
        { type: 'ejendom', bfe: 100 },
        mkPolicy({ policy: { id: 'p1', sum_insured_dkk: 5_000_000 } as never })
      ),
    ];
    const r = await runTinglysningCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
    expect(r.haeftelserByBfe.get(100)).toBe(1_000_000);
  });

  it('graceful: fetch-fejl → tom liste, ingen throw', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('net')) as never;
    const matches: MatchResult[] = [
      mkMatch(
        { type: 'ejendom', bfe: 100 },
        mkPolicy({ policy: { id: 'p1', sum_insured_dkk: 1_000_000 } as never })
      ),
    ];
    const r = await runTinglysningCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
  });

  it('graceful: non-200 response springes over', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 })) as never;
    const matches: MatchResult[] = [
      mkMatch(
        { type: 'ejendom', bfe: 100 },
        mkPolicy({ policy: { id: 'p1', sum_insured_dkk: 1_000_000 } as never })
      ),
    ];
    const r = await runTinglysningCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
    expect(r.haeftelserByBfe.size).toBe(0);
  });

  it('springer ikke-ejendom-aktiver over', async () => {
    global.fetch = vi.fn();
    const matches: MatchResult[] = [mkMatch({ type: 'virksomhed', bfe: undefined }, mkPolicy({}))];
    const r = await runTinglysningCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('runVurCrossCheck', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('flagger GAP-104 når vurdering > police × 1.5', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ vurdering: { ejendomsvaerdi: 10_000_000 } }), { status: 200 })
      ) as never;
    const matches: MatchResult[] = [
      mkMatch(
        { type: 'ejendom', bfe: 100 },
        mkPolicy({ policy: { id: 'p1', sum_insured_dkk: 5_000_000 } as never })
      ),
    ];
    const r = await runVurCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].check_id).toBe('GAP-104');
    expect(r.vurderingByBfe.get(100)).toBe(10_000_000);
  });

  it('ingen gap hvis vurdering ≤ police × 1.5', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ vurdering: { ejendomsvaerdi: 6_000_000 } }), { status: 200 })
      ) as never;
    const matches: MatchResult[] = [
      mkMatch(
        { type: 'ejendom', bfe: 100 },
        mkPolicy({ policy: { id: 'p1', sum_insured_dkk: 5_000_000 } as never })
      ),
    ];
    const r = await runVurCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
    expect(r.vurderingByBfe.get(100)).toBe(6_000_000);
  });

  it('graceful: fetch-fejl → tom', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('net')) as never;
    const matches: MatchResult[] = [mkMatch({ type: 'ejendom', bfe: 100 }, mkPolicy({}))];
    const r = await runVurCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
  });
});

describe('runBbrCrossCheck', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returnerer tomt resultat når ingen ejendomme matches', async () => {
    global.fetch = vi.fn();
    const matches: MatchResult[] = [mkMatch({ type: 'virksomhed' }, mkPolicy({}))];
    const r = await runBbrCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
    expect(r.bbrByBfe.size).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('graceful: BBR API non-200 → tom uden throw', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('err', { status: 500 })) as never;
    const matches: MatchResult[] = [mkMatch({ type: 'ejendom', bfe: 100 }, mkPolicy({}))];
    const r = await runBbrCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
    expect(r.bbrByBfe.size).toBe(0);
  });

  it('graceful: fetch-throw → tom', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('boom')) as never;
    const matches: MatchResult[] = [mkMatch({ type: 'ejendom', bfe: 100 }, mkPolicy({}))];
    const r = await runBbrCrossCheck(matches, 'http://h', 'c=1');
    expect(r.gaps).toEqual([]);
  });
});

// ─── detectKlyngerisiko ─────────────────────────────────────────────────────

describe('detectKlyngerisiko', () => {
  it('flagger postnummer med >50% af samlet sum', () => {
    const matches: MatchResult[] = [
      mkMatch(
        { adresse: 'Testvej 1, 2100 København Ø' },
        mkPolicy({
          policy: {
            id: 'p1',
            sum_insured_dkk: 8_000_000,
            property_address: 'Testvej 1, 2100 København Ø',
          } as never,
        })
      ),
      mkMatch(
        { adresse: 'Testvej 2, 2100 København Ø' },
        mkPolicy({
          policy: {
            id: 'p2',
            sum_insured_dkk: 1_500_000,
            property_address: 'Testvej 2, 2100 København Ø',
          } as never,
        })
      ),
      mkMatch(
        { adresse: 'Vejvej 3, 8000 Aarhus' },
        mkPolicy({
          policy: {
            id: 'p3',
            sum_insured_dkk: 500_000,
            property_address: 'Vejvej 3, 8000 Aarhus',
          } as never,
        })
      ),
    ];
    const gaps = detectKlyngerisiko([], matches);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].check_id).toBe('GAP-105');
    expect(gaps[0].title).toContain('2100');
    expect(gaps[0].severity).toBe('warning');
  });

  it('ingen gap når sum jævnt fordelt (<=50%)', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', sum_insured_dkk: 1_000_000, property_address: '2100' } as never,
        })
      ),
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p2', sum_insured_dkk: 1_000_000, property_address: '8000' } as never,
        })
      ),
    ];
    expect(detectKlyngerisiko([], matches)).toEqual([]);
  });

  it('ingen gap når kun ét postnummer (postnrSums.size===1)', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', sum_insured_dkk: 5_000_000, property_address: '2100' } as never,
        })
      ),
    ];
    expect(detectKlyngerisiko([], matches)).toEqual([]);
  });

  it('ignorerer matches uden sum_insured', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({ policy: { id: 'p1', sum_insured_dkk: null, property_address: '2100' } as never })
      ),
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p2', sum_insured_dkk: 1_000_000, property_address: '8000' } as never,
        })
      ),
    ];
    expect(detectKlyngerisiko([], matches)).toEqual([]);
  });
});

// ─── detectRestaurantKrav ───────────────────────────────────────────────────

describe('detectRestaurantKrav', () => {
  it('flagger ejendom med branche="restaurant"', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: {
            id: 'p1',
            business_activity: 'restaurant',
            property_address: 'Strøget',
          } as never,
        })
      ),
    ];
    const gaps = detectRestaurantKrav([], matches);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].check_id).toBe('GAP-106');
    expect(gaps[0].severity).toBe('info');
  });

  it('flagger café-branche', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', business_activity: 'CAFÉ', property_address: null } as never,
        })
      ),
    ];
    expect(detectRestaurantKrav([], matches)).toHaveLength(1);
  });

  it('flagger kantine via building_use', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', building_use: 'Personalekantine', business_activity: null } as never,
        })
      ),
    ];
    expect(detectRestaurantKrav([], matches)).toHaveLength(1);
  });

  it('ingen gap for kontor-branche', () => {
    const matches: MatchResult[] = [
      mkMatch({}, mkPolicy({ policy: { id: 'p1', business_activity: 'rådgivning' } as never })),
    ];
    expect(detectRestaurantKrav([], matches)).toEqual([]);
  });
});

// ─── detectAnbefalinger ─────────────────────────────────────────────────────

describe('detectAnbefalinger', () => {
  it('GAP-107 D&O: A/S med bestyrelse uden D&O police', () => {
    const aktiver: Aktiv[] = [
      { type: 'bestyrelsespost', label: 'CEO', cvr: '11', rawData: { virksomhedsform: 'A/S' } },
    ];
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', business_activity: 'real estate', raw_metadata: {} } as never,
        })
      ),
    ];
    const gaps = detectAnbefalinger(aktiver, matches);
    const dno = gaps.find((g) => g.check_id === 'GAP-107');
    expect(dno).toBeDefined();
    expect(dno?.title).toMatch(/D&O/);
  });

  it('GAP-107 spring over hvis D&O allerede tegnet', () => {
    const aktiver: Aktiv[] = [
      { type: 'bestyrelsespost', label: 'CEO', cvr: '11', rawData: { virksomhedsform: 'A/S' } },
    ];
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', business_activity: 'D&O ledelsesansvar', raw_metadata: {} } as never,
        })
      ),
    ];
    expect(
      detectAnbefalinger(aktiver, matches).find((g) => g.check_id === 'GAP-107')
    ).toBeUndefined();
  });

  it('GAP-108 Cyber: virksomhed med ansatte uden cyber-police', () => {
    const aktiver: Aktiv[] = [{ type: 'virksomhed', label: 'V', cvr: '11', ansatte: 50 }];
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', business_activity: 'real estate', raw_metadata: {} } as never,
        })
      ),
    ];
    const gaps = detectAnbefalinger(aktiver, matches);
    expect(gaps.find((g) => g.check_id === 'GAP-108')).toBeDefined();
  });

  it('GAP-108 spring over hvis cyber/GDPR i police', () => {
    const aktiver: Aktiv[] = [{ type: 'virksomhed', label: 'V', cvr: '11', ansatte: 5 }];
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({ policy: { id: 'p1', business_activity: 'cyber GDPR-tillæg' } as never })
      ),
    ];
    expect(
      detectAnbefalinger(aktiver, matches).find((g) => g.check_id === 'GAP-108')
    ).toBeUndefined();
  });

  it('GAP-109 Driftstab: udlejning uden driftstabsforsikring', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', business_activity: 'erhvervsudlejning', raw_metadata: {} } as never,
        })
      ),
    ];
    const gaps = detectAnbefalinger([], matches);
    expect(gaps.find((g) => g.check_id === 'GAP-109')).toBeDefined();
  });

  it('GAP-109 spring over hvis driftstab i police', () => {
    const matches: MatchResult[] = [
      mkMatch(
        {},
        mkPolicy({
          policy: { id: 'p1', business_activity: 'udlejning + driftstabsforsikring' } as never,
        })
      ),
    ];
    expect(detectAnbefalinger([], matches).find((g) => g.check_id === 'GAP-109')).toBeUndefined();
  });

  it('ingen gaps når koncernen ikke matcher nogen trigger', () => {
    const aktiver: Aktiv[] = [{ type: 'ejendom', label: 'BFE 100', bfe: 100 }];
    const matches: MatchResult[] = [];
    expect(detectAnbefalinger(aktiver, matches)).toEqual([]);
  });
});
