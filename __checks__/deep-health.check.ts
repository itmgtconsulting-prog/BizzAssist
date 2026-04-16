/**
 * Deep health check — verifies infrastructure (DB, Redis, external APIs, certs).
 * Runs every 15 minutes. Catches infrastructure degradation before users notice.
 * BIZZ-311: Synthetic monitoring for infrastructure health.
 */

import { ApiCheck, AssertionBuilder, Frequency } from 'checkly/constructs';

new ApiCheck('deep-health-check', {
  name: 'Deep Infrastructure Health',
  activated: true,
  frequency: Frequency.EVERY_15M,
  locations: ['eu-north-1'],
  request: {
    url: 'https://app.bizzassist.dk/api/health?deep=true',
    method: 'GET',
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.jsonBody('$.status').notEquals('down'),
      AssertionBuilder.jsonBody('$.checks.database').equals('ok'),
      AssertionBuilder.responseTime().lessThan(10000),
    ],
  },
  alertChannels: [],
});
