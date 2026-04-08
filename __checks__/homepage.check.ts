/**
 * Homepage availability check — verifies the marketing page loads.
 * Runs every 10 minutes from EU regions.
 *
 * BIZZ-60: Checkly monitoring config
 */

import { ApiCheck, AssertionBuilder, Frequency } from 'checkly/constructs';

new ApiCheck('homepage-check', {
  name: 'Homepage',
  activated: true,
  frequency: Frequency.EVERY_10M,
  locations: ['eu-north-1', 'eu-west-1'],
  request: {
    url: 'https://app.bizzassist.dk',
    method: 'GET',
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.responseTime().lessThan(5000),
    ],
  },
  alertChannels: [],
});
