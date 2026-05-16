/**
 * Unit tests for Data Intelligence agentic orchestrator (BIZZ-1560, L1.2).
 *
 * routeQuery er mocket — vi tester ikke Claude API her, kun orchestrator-
 * flowet. Resultat-policies: cache hit kort-cirkuiterer, semantic-fallback
 * retry på 0 rows, clarify/decline videregives uændret.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agenticAsk, relaxPlan } from '@/app/lib/dataIntelligence/semantic/agenticAsk';
import type { ScorecardReader } from '@/app/lib/dataIntelligence/semantic/cacheRouter';
import type { QueryPlan } from '@/app/lib/dataIntelligence/semantic/queryPlan';

// Mock routeQuery — vi vil styre output deterministisk
vi.mock('@/app/lib/dataIntelligence/semantic/router', async () => {
  const actual = await vi.importActual<typeof import('@/app/lib/dataIntelligence/semantic/router')>(
    '@/app/lib/dataIntelligence/semantic/router'
  );
  return {
    ...actual,
    routeQuery: vi.fn(),
  };
});

import { routeQuery } from '@/app/lib/dataIntelligence/semantic/router';

const mockRoute = vi.mocked(routeQuery);

const PLAN_COUNT: QueryPlan = {
  metrics: ['count_handler'],
  dimensions: [],
  filters: [],
};

const PLAN_TIME: QueryPlan = {
  metrics: ['count_handler'],
  dimensions: [],
  filters: [],
  timeRange: { dimension: 'dato', preset: 'last_30_days' },
};

const PLAN_FILTER: QueryPlan = {
  metrics: ['count_handler'],
  dimensions: [],
  filters: [{ dimension: 'kommune_kode', op: 'eq', value: 101 }],
};

beforeEach(() => {
  mockRoute.mockReset();
});

describe('relaxPlan', () => {
  it('fjerner timeRange først', () => {
    const r = relaxPlan(PLAN_TIME);
    expect(r?.timeRange).toBeUndefined();
    expect(r?.metrics).toEqual(['count_handler']);
  });
  it('fjerner sidste filter når ingen timeRange', () => {
    const r = relaxPlan(PLAN_FILTER);
    expect(r?.filters).toEqual([]);
  });
  it('returnerer null når intet at relaxe', () => {
    expect(relaxPlan(PLAN_COUNT)).toBeNull();
  });
});

describe('agenticAsk — routing outputs', () => {
  it('returnerer clarify uændret', async () => {
    mockRoute.mockResolvedValueOnce({
      kind: 'needs_clarification',
      message: 'Over hvilken periode?',
      alternatives: [
        { description: 'Sidste 12 mdr', plan: PLAN_TIME },
        { description: 'Hele 2025', plan: PLAN_COUNT },
      ],
    });
    const r = await agenticAsk('vis handler', { sqlRunner: vi.fn() });
    expect(r.kind).toBe('clarify');
    if (r.kind !== 'clarify') return;
    expect(r.message).toMatch(/periode/);
    expect(r.alternatives).toHaveLength(2);
    expect(r.trace.sqlAttempts).toBe(0);
  });

  it('returnerer decline ved fallback_to_generative', async () => {
    mockRoute.mockResolvedValueOnce({
      kind: 'fallback_to_generative',
      reason: 'ingen metric matcher',
    });
    const r = await agenticAsk('hvad er din yndlingsfarve', { sqlRunner: vi.fn() });
    expect(r.kind).toBe('decline');
    if (r.kind !== 'decline') return;
    expect(r.reason).toMatch(/ingen metric/);
  });

  it('returnerer failed hvis routeQuery kaster', async () => {
    mockRoute.mockRejectedValueOnce(new Error('claude timeout'));
    const r = await agenticAsk('vis handler', { sqlRunner: vi.fn() });
    expect(r.kind).toBe('failed');
  });
});

describe('agenticAsk — cache short-circuit', () => {
  it('returnerer scorecard-hit uden at kalde sqlRunner', async () => {
    mockRoute.mockResolvedValueOnce({
      kind: 'plan',
      plan: PLAN_COUNT,
      confidence: 0.95,
      persona: 'journalist',
    });
    const reader: ScorecardReader = {
      fetchOne: vi.fn(async () => ({
        value_numeric: 12345,
        display_name: 'Antal handler',
        unit: 'antal',
        format: 'integer' as const,
        refreshed_at: '2026-05-16T04:00:00Z',
      })),
    };
    const sqlRunner = vi.fn();
    const r = await agenticAsk('hvor mange handler er der?', {
      sqlRunner,
      scorecardReader: reader,
      skipRedis: true,
    });
    expect(r.kind).toBe('data');
    if (r.kind !== 'data') return;
    expect(r.data.layer).toBe('scorecard');
    expect(r.trace.source).toBe('cache');
    expect(r.trace.cacheLayer).toBe('scorecard');
    expect(sqlRunner).not.toHaveBeenCalled();
  });
});

describe('agenticAsk — semantic execution', () => {
  it('kører SQL når cache misser', async () => {
    mockRoute.mockResolvedValueOnce({
      kind: 'plan',
      plan: PLAN_COUNT,
      confidence: 0.95,
      persona: 'journalist',
    });
    const sqlRunner = vi.fn().mockResolvedValue([{ count_handler: 42 }]);
    const r = await agenticAsk('vis handler', { sqlRunner, skipRedis: true });
    expect(r.kind).toBe('data');
    if (r.kind !== 'data') return;
    expect(r.data.layer).toBe('semantic');
    expect(r.trace.source).toBe('semantic');
    expect(r.trace.sqlAttempts).toBe(1);
    expect(sqlRunner).toHaveBeenCalledOnce();
  });

  it('retry-on-empty: relakser timeRange og prøver igen', async () => {
    mockRoute.mockResolvedValueOnce({
      kind: 'plan',
      plan: PLAN_TIME,
      confidence: 0.95,
      persona: 'journalist',
    });
    const sqlRunner = vi
      .fn()
      .mockResolvedValueOnce([]) // første try: 0 rows
      .mockResolvedValueOnce([{ count_handler: 99 }]); // efter relax
    const r = await agenticAsk('handler sidste 30 dage', {
      sqlRunner,
      skipRedis: true,
    });
    expect(r.kind).toBe('data');
    if (r.kind !== 'data') return;
    expect(sqlRunner).toHaveBeenCalledTimes(2);
    expect(r.trace.sqlAttempts).toBe(2);
    expect(r.trace.warnings.some((w) => w.includes('relakserer'))).toBe(true);
  });

  it('giver op efter MAX iterations på fortsat 0 rows', async () => {
    mockRoute.mockResolvedValueOnce({
      kind: 'plan',
      plan: PLAN_FILTER,
      confidence: 0.95,
      persona: 'journalist',
    });
    const sqlRunner = vi.fn().mockResolvedValue([]);
    const r = await agenticAsk('vis tomt filter', {
      sqlRunner,
      skipRedis: true,
    });
    // PLAN_FILTER relaxes til PLAN_COUNT — anden iteration returnerer []
    // og vi rammer MAX_SQL_ATTEMPTS; svaret er data med 0 rows
    expect(r.kind).toBe('data');
    if (r.kind !== 'data') return;
    expect(sqlRunner).toHaveBeenCalledTimes(2);
    expect(r.trace.sqlAttempts).toBe(2);
  });

  it('returnerer failed ved SQL-fejl', async () => {
    mockRoute.mockResolvedValueOnce({
      kind: 'plan',
      plan: PLAN_COUNT,
      confidence: 0.95,
      persona: 'journalist',
    });
    const sqlRunner = vi.fn().mockRejectedValueOnce(new Error('column missing'));
    const r = await agenticAsk('vis handler', { sqlRunner, skipRedis: true });
    expect(r.kind).toBe('failed');
    if (r.kind !== 'failed') return;
    expect(r.reason).toMatch(/column missing/);
    expect(r.trace.warnings[0]).toMatch(/SQL fejl/);
  });
});
