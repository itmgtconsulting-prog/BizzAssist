/**
 * Login page check — verifies /login loads correctly.
 * BIZZ-311: Synthetic monitoring for critical user flows.
 */

import { ApiCheck, AssertionBuilder, Frequency } from 'checkly/constructs';

new ApiCheck('login-page-check', {
  name: 'Login Page',
  activated: true,
  frequency: Frequency.EVERY_10M,
  locations: ['eu-north-1', 'eu-west-1'],
  request: {
    url: 'https://app.bizzassist.dk/login',
    method: 'GET',
    assertions: [
      AssertionBuilder.statusCode().equals(200),
      AssertionBuilder.responseTime().lessThan(5000),
    ],
  },
  alertChannels: [],
});
