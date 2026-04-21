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
    },
  },
]);

export default eslintConfig;
