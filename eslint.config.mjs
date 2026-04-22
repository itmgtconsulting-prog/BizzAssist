import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Generated coverage reports contain minified bundles — not source code
    'coverage/**',
    // Vercel build output — generated bundles, not source code
    '.vercel/**',
    // Git worktrees created by Claude Code agents — not the main working tree
    '.claude/**',
    // Ad-hoc ops/verification scripts — one-off tools run by hand, not production code.
    // Linting would block PRs for throwaway stub-variables. Keep linting for app/ and __tests__/.
    'scripts/**',
  ]),
  {
    rules: {
      // Regel er for aggressiv — blokerer lovlig async setState i .then()-callbacks.
      // Standard React data-fetching mønster (fetch i useEffect → setState i callback)
      // er ikke en cascade-render risiko og er dokumenteret i React docs.
      'react-hooks/set-state-in-effect': 'off',
      // Ubrugte imports/variabler skal give fejl — fanger stale imports der
      // crasher Turbopack runtime (som AlertTriangle-buggen 2026-03-28).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // BIZZ-722 Lag 4+6: Forbid raw supabase.from('domain_*') calls outside helpers.
      // All domain table access MUST go through domainScopedQuery / domainEmbedding /
      // domainStorage helpers to enforce mandatory domain_id filtering.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='from'][arguments.0.type='Literal'][arguments.0.value=/^domain_/]",
          message:
            'Direct supabase.from(\'domain_*\') is forbidden. Use domainScopedQuery(), domainEmbedding helpers, or domainStorage — they enforce mandatory domain_id filtering (BIZZ-722).',
        },
      ],
    },
  },
  // Allow the restricted pattern inside domain helpers + admin APIs + tests.
  // Super-admin endpoints operate across domains and membership is checked separately.
  {
    files: [
      'app/lib/domainScopedQuery.ts',
      'app/lib/domainEmbedding.ts',
      'app/lib/domainStorage.ts',
      'app/lib/domainAuth.ts',
      'app/lib/domainEmbeddingWorker.ts',
      'app/lib/domainPromptBuilder.ts',
      // Domain admin API routes — scoped by assertDomainAdmin at entry
      'app/api/domain/**',
      // Super-admin API routes — operate across domains by design
      'app/api/admin/domains/**',
      // Anomaly-scan cron is super-admin-equivalent (runs under service role)
      'app/api/cron/domain-anomalies/**',
      'app/api/cron/domain-retention/**',
      '__tests__/**',
      // Build scripts and verification scripts may touch domain tables directly
      'scripts/**',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]);

export default eslintConfig;
