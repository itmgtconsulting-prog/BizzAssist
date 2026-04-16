import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vitest configuration for BizzAssist.
 *
 * Test types:
 *  - Unit tests:      __tests__/unit/        (fast, isolated)
 *  - Component tests: __tests__/components/  (React Testing Library)
 *  - Integration:     __tests__/integration/ (API routes, DB logic)
 *
 * Run: npm test
 * Watch: npm run test:watch
 * Coverage: npm run test:coverage
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: [
        'node_modules/**',
        '.next/**',
        'playwright/**',
        '**/*.config.*',
        '**/types/**',
        // API routes are server-side I/O code — tested via E2E (Playwright), not unit tests.
        // Including them in unit-test coverage would require heavy mocking of external APIs
        // (Datafordeler, CVR, BBR, Supabase) and would not add meaningful signal.
        'app/api/**',
        // External-API client libraries — integration-level code, covered by E2E.
        'app/lib/dawa.ts',
        'app/lib/dar.ts',
        'app/lib/dfCertAuth.ts',
        'app/lib/dfProxy.ts',
      ],
      // Minimum coverage thresholds — CI will fail below these.
      // Measured over unit-testable code (UI components, lib utilities, context).
      // API routes and external-API clients are excluded (see above).
      thresholds: {
        lines: 45,
        functions: 40,
        branches: 30,
      },
    },
    // Component tests render React trees in jsdom which can be slow on
    // resource-constrained machines — raise the per-test timeout to 15s.
    testTimeout: 15000,
    // Cap concurrent workers to prevent "Timeout waiting for worker to respond" errors.
    // Without this limit vitest spawns one fork per CPU core, which overwhelms the OS
    // scheduler on loaded machines and causes spurious worker-spawn timeouts.
    maxWorkers: 4,
    include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '__tests__/e2e/**',
      'node_modules/**',
      // RLS isolation tests require a live Supabase instance and real auth sessions.
      // They are incompatible with the jsdom unit-test environment and are excluded
      // from the default test run. Run explicitly with: npm run test:rls
      '__tests__/integration/rls-isolation.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
