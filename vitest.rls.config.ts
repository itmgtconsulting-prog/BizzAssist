import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest configuration specifically for RLS (Row Level Security) isolation tests.
 *
 * These tests connect to a live Supabase dev instance and require real auth sessions.
 * They are intentionally excluded from the default vitest.config.ts because:
 *  - They require network access to Supabase
 *  - They are incompatible with the jsdom unit-test environment
 *  - They use real credentials that must only run in trusted CI environments
 *
 * Run: npm run test:rls
 * Requires: RLS_TEST=true environment variable
 *
 * ISO 27001 A.9 (Access Control) — verifies RLS tenant isolation enforcement.
 * BIZZ-141 / BIZZ-142 / BIZZ-143 / BIZZ-144 — regression guard.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Only run the RLS isolation test — no other tests
    include: ['__tests__/integration/rls-isolation.test.ts'],
    exclude: ['node_modules/**'],
    // RLS tests make real network calls to Supabase — allow up to 30s per test
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run serially — these tests depend on shared auth state set up in beforeAll
    pool: 'forks',
    singleFork: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
