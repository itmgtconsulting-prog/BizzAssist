import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // BIZZ-61: Sample 10% of server-side traces in production, 100% in dev
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // BIZZ-61: Alert thresholds are configured in the Sentry dashboard (not in code).
  // Current rule: alert when error rate exceeds 5 errors/minute on the bizzassist project.
  // To update: Sentry → Alerts → bizzassist → "High error rate" rule.
});
