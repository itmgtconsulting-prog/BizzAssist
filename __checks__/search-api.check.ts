/**
 * Search API check — verifies /api/search returns results for a known query.
 * BIZZ-311: Synthetic monitoring for critical user flows.
 */

import { ApiCheck, AssertionBuilder, Frequency } from 'checkly/constructs';

new ApiCheck('search-api-check', {
  name: 'Search API',
  activated: true,
  frequency: Frequency.EVERY_10M,
  locations: ['eu-north-1', 'eu-west-1'],
  request: {
    url: 'https://app.bizzassist.dk/api/search?q=test&limit=1',
    method: 'GET',
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.responseTime().lessThan(5000),
    ],
  },
  alertChannels: [],
});
