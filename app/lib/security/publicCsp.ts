/**
 * Statisk Content-Security-Policy for public/SEO-routes (BIZZ-2244).
 *
 * proxy.ts saetter en nonce-baseret CSP paa app-routes (dashboard/login/api/…),
 * men springer bevidst public/SEO-routes over saa de forbliver ISR-cachebare (en
 * per-request nonce tvinger dynamisk render → no-store → ingen Google-indeksering).
 * De fik derfor SLET ingen CSP. Denne statiske policy (nonce umulig i statisk
 * header → 'unsafe-inline' scripts) lukker hullet med reelle clickjacking-/
 * injection-vaern og er ISR-sikker. Delt mellem next.config.ts og regressionstest.
 */

/** Statisk CSP-vaerdi for public-routes. Spejler proxy.ts' connect/img/font-kilder. */
export const PUBLIC_STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://browser.sentry-cdn.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://*.supabase.co https://*.supabase.io wss://*.supabase.co https://*.sentry.io https://o4511077193416704.ingest.de.sentry.io https://api.dataforsyningen.dk https://*.mapbox.com https://events.mapbox.com",
  "worker-src blob: 'self'",
  "child-src blob: 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ');

/**
 * Public-route-kilder der IKKE matches af proxy.ts (og derfor manglede CSP).
 * Matcher proxy.ts' PUBLIC_CACHEABLE_PATHS så der ikke opstaar dobbelt-CSP-header.
 */
export const PUBLIC_CSP_SOURCES: readonly string[] = [
  '/',
  '/ejendom/:path*',
  '/virksomhed/:path*',
  '/privacy',
  '/terms',
];
