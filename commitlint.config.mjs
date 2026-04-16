/**
 * Commitlint configuration — enforces Conventional Commits format.
 * ISO 27001 A.14: ensures commit history is auditable and consistent.
 *
 * Format: <type>(<scope>): <subject>
 * Example: feat(auth): add Google OAuth login
 *          fix(cvr): handle null financials in annual report parser
 *          docs(security): update ISMS review schedule
 *
 * Types:
 *   feat     - new feature
 *   fix      - bug fix
 *   docs     - documentation only
 *   style    - formatting, no logic change
 *   refactor - code change that neither fixes a bug nor adds a feature
 *   perf     - performance improvement
 *   test     - adding or correcting tests
 *   chore    - maintenance (deps, config, build)
 *   security - security fix or hardening
 *   ci       - CI/CD pipeline changes
 */

const config = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'security', 'ci'],
    ],
    'subject-case': [2, 'always', 'lower-case'],
    'subject-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 200],
    'scope-case': [2, 'always', 'lower-case'],
  },
};

export default config;
