/**
 * Checkly monitoring configuration — BIZZ-60
 *
 * Monitors BizzAssist's critical API endpoints.
 * Install: npm install --save-dev checkly
 * Deploy: npx checkly deploy --force
 *
 * Required env: CHECKLY_API_KEY, CHECKLY_ACCOUNT_ID (from checkly.com dashboard)
 */

import { defineConfig } from 'checkly';
import { Frequency } from 'checkly/constructs';

export default defineConfig({
  projectName: 'BizzAssist',
  logicalId: 'bizzassist-monitoring',
  repoUrl: 'https://github.com/itmgtconsulting-prog/BizzAssist',
  checks: {
    activated: true,
    muted: false,
    runtimeId: '2024.02',
    frequency: Frequency.EVERY_5M,
    locations: ['eu-north-1', 'eu-west-1'],
    tags: ['production'],
    checkMatch: '__checks__/**/*.check.ts',
    browserChecks: {
      frequency: Frequency.EVERY_10M,
      testMatch: '__checks__/**/*.spec.ts',
    },
  },
  cli: {
    runLocation: 'eu-north-1',
    reporters: ['list'],
  },
});
