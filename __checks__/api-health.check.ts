/**
 * Health check — verifies /api/health returns 200.
 * Runs every 5 minutes from EU regions.
 *
 * BIZZ-60: Checkly monitoring config
 */

import { ApiCheck, AssertionBuilder, Frequency } from 'checkly/constructs';

new ApiCheck('api-health-check', {
  name: 'API Health',
  activated: true,
  frequency: Frequency.EVERY_5M,
  locations: ['eu-north-1', 'eu-west-1'],
  request: {
    url: 'https://app.bizzassist.dk/api/health',
    method: 'GET',
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.jsonBody('$.status').equals('ok'),
      AssertionBuilder.responseTime().lessThan(3000),
    ],
  },
  alertChannels: [],
});
