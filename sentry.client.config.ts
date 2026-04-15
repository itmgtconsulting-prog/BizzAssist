import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // Capture 100% of transactions in development, 10% in production
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // BIZZ-61: Continuous profiling — 10% of sampled transactions
  profilesSampleRate: 0.1,

  // BIZZ-61: Capture replays for 5% of sessions, 100% on error
  // Lower session rate (0.05) reduces storage costs while preserving full error coverage.
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1.0,

  // BIZZ-61: Alert thresholds are configured in the Sentry dashboard (not in code).
  // Current rule: alert when error rate exceeds 5 errors/minute on the bizzassist project.
  // To update: Sentry → Alerts → bizzassist → "High error rate" rule.

  integrations: [
    Sentry.replayIntegration({
      // BIZZ-129: Mask all text and block media to prevent PII leaking into session replays
      maskAllText: true,
      blockAllMedia: true,
    }),
    // BIZZ-61: Core Web Vitals + navigation/resource timing tracing
    Sentry.browserTracingIntegration(),
  ],

  /**
   * Strip sensitive query parameters from request URLs before sending to Sentry.
   * Prevents PII (addresses, CVR numbers, BFE ids, search terms) from appearing
   * in Sentry event breadcrumbs and request metadata.
   *
   * @param event - The Sentry event to sanitise
   * @returns The sanitised event
   */
  beforeSend(event) {
    if (event.request?.url) {
      try {
        const url = new URL(event.request.url);
        // BIZZ-298: Strip all PII-bearing query params from Sentry events
        [
          'search',
          'query',
          'q',
          'cvr',
          'bfe',
          'adresse',
          'id',
          'email',
          'phone',
          'enhedsNummer',
          'vejnavn',
          'husnr',
          'postnr',
          'navn',
        ].forEach((p) => url.searchParams.delete(p));
        event.request.url = url.toString();
      } catch {
        // Malformed URL — leave as-is rather than dropping the event
      }
    }
    return event;
  },

  // Ignore known non-critical errors
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
    /^Network request failed/,
  ],
});
