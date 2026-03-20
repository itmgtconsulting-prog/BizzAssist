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
      exclude: ['node_modules/**', '.next/**', 'playwright/**', '**/*.config.*', '**/types/**'],
      // Minimum coverage thresholds — CI will fail below these
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
    include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['__tests__/e2e/**', 'node_modules/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
