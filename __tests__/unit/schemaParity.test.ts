/**
 * BIZZ-2196: Unit tests for the structural schema-parity diff logic.
 *
 * Exercises the pure diff functions from scripts/check-schema-parity.mjs with
 * synthetic snapshots — no database access — so the gate's core logic is
 * regression-protected in CI. The live cross-env introspection runs in the
 * scheduled schema-parity.yml workflow.
 */
import { describe, it, expect } from 'vitest';
// Plain ESM .mjs helper with no type declarations — cast the module to a loose
// record so tsc doesn't try (and fail) to infer types from the JS source.
import * as parityModule from '../../scripts/check-schema-parity.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  onlyIn,
  crossEnvTableDrift,
  crossEnvColumnDrift,
  crossEnvFunctionDrift,
  tenantTemplateDrift,
  summarize,
  ALLOWLIST,
} = parityModule as unknown as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('onlyIn', () => {
  it('returns sorted elements of a missing from b', () => {
    expect(onlyIn(['c', 'a', 'b'], ['b'])).toEqual(['a', 'c']);
  });
  it('accepts a Set as the second arg', () => {
    expect(onlyIn(['a', 'b'], new Set(['a']))).toEqual(['b']);
  });
});

describe('crossEnvTableDrift', () => {
  it('flags tables missing in an env and honours the allowlist', () => {
    const snapshots = {
      prod: ['public.a', 'public.b', 'public.tmp_ejerforening_cvr'],
      test: ['public.a'],
      dev: ['public.a', 'public.b'],
    };
    const { missingByEnv } = crossEnvTableDrift(snapshots);
    // tmp_ejerforening_cvr is allowlisted → never part of the union
    expect(missingByEnv.prod).toEqual([]);
    expect(missingByEnv.test).toEqual(['public.b']);
    expect(missingByEnv.dev).toEqual([]);
  });

  it('reports full parity as empty arrays', () => {
    const s = { prod: ['public.a'], test: ['public.a'], dev: ['public.a'] };
    const { missingByEnv } = crossEnvTableDrift(s);
    expect(Object.values(missingByEnv).every((a) => (a as string[]).length === 0)).toBe(true);
  });
});

describe('crossEnvColumnDrift', () => {
  it('only compares tables present in every env', () => {
    const snapshots = {
      // public.b exists only in prod → excluded from column comparison
      prod: ['public.a.id:uuid', 'public.a.name:text', 'public.b.x:int'],
      test: ['public.a.id:uuid'],
      dev: ['public.a.id:uuid'],
    };
    const { extraByEnv } = crossEnvColumnDrift(snapshots);
    expect(extraByEnv.prod).toEqual(['public.a.name']); // b.x excluded (b not common)
    expect(extraByEnv.test).toEqual([]);
    expect(extraByEnv.dev).toEqual([]);
  });

  it('detects a column type-only presence difference by column identity', () => {
    const snapshots = {
      prod: ['public.a.id:uuid'],
      test: ['public.a.id:uuid', 'public.a.extra:text'],
      dev: ['public.a.id:uuid'],
    };
    const { extraByEnv } = crossEnvColumnDrift(snapshots);
    expect(extraByEnv.test).toEqual(['public.a.extra']);
  });
});

describe('crossEnvFunctionDrift', () => {
  it('flags functions unique to one env', () => {
    const s = {
      prod: ['f/1', 'g/0'],
      test: ['f/1'],
      dev: ['f/1'],
    };
    const { extraByEnv } = crossEnvFunctionDrift(s);
    expect(extraByEnv.prod).toEqual(['g/0']);
  });
});

describe('tenantTemplateDrift', () => {
  it('reports schemas deviating from the most-common fingerprint', () => {
    const rows = [
      // 2 canonical schemas
      { s: 'tenant_a', tc: 'notes.id' },
      { s: 'tenant_a', tc: 'notes.user_id' },
      { s: 'tenant_b', tc: 'notes.id' },
      { s: 'tenant_b', tc: 'notes.user_id' },
      // 1 deviating schema (missing user_id, has legacy col)
      { s: 'tenant_c', tc: 'notes.id' },
      { s: 'tenant_c', tc: 'notes.summary' },
    ];
    const d = tenantTemplateDrift(rows);
    expect(d.schemaCount).toBe(3);
    expect(d.canonicalCount).toBe(2);
    expect(d.deviations).toHaveLength(1);
    expect(d.deviations[0].schema).toBe('tenant_c');
    expect(d.deviations[0].missing).toEqual(['notes.user_id']);
    expect(d.deviations[0].extra).toEqual(['notes.summary']);
  });

  it('returns no deviations when all schemas match', () => {
    const rows = [
      { s: 'tenant_a', tc: 'x.id' },
      { s: 'tenant_b', tc: 'x.id' },
    ];
    expect(tenantTemplateDrift(rows).deviations).toEqual([]);
  });

  it('handles an env with no tenant schemas', () => {
    expect(tenantTemplateDrift([]).schemaCount).toBe(0);
  });
});

describe('summarize', () => {
  const clean = {
    tableDrift: { missingByEnv: { prod: [], test: [], dev: [] } },
    columnDrift: { extraByEnv: { prod: [], test: [], dev: [] } },
    functionDrift: { extraByEnv: { prod: [], test: [], dev: [] } },
    tenantDriftByEnv: {
      prod: { deviations: [] },
      test: { deviations: [] },
      dev: { deviations: [] },
    },
  };

  it('reports no drift for a clean snapshot', () => {
    expect(summarize(clean).hasDrift).toBe(false);
  });

  it('reports drift if any single category drifts', () => {
    const withCol = {
      ...clean,
      columnDrift: { extraByEnv: { prod: ['public.a.x'], test: [], dev: [] } },
    };
    const r = summarize(withCol);
    expect(r.hasDrift).toBe(true);
    expect(r.colHas).toBe(true);
  });
});

describe('ALLOWLIST', () => {
  it('documents the two intentional junk tables', () => {
    expect(ALLOWLIST.tables.has('public.tmp_ejerforening_cvr')).toBe(true);
    expect(ALLOWLIST.tables.has('public.tinglysning_backfill_probed')).toBe(true);
  });
});
