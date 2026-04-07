import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // Capture 100% of transactions in development, 10% in production
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Capture replays for 10% of sessions, 100% on error
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  integrations: [
    Sentry.replayIntegration({
      // BIZZ-129: Mask all text and block media to prevent PII leaking into session replays
      maskAllText: true,
      blockAllMedia: true,
    }),
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
        ['search', 'query', 'q', 'cvr', 'bfe', 'adresse', 'id'].forEach((p) =>
          url.searchParams.delete(p)
        );
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
