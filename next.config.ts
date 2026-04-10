import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

/**
 * Bundle analyzer — enabled when ANALYZE=true is set in the environment.
 * Used by the BIZZ-63 bundle-size GitHub Actions workflow.
 * Requires `@next/bundle-analyzer` to be installed as a dev dependency.
 * Install with: npm install --save-dev @next/bundle-analyzer
 */
const withBundleAnalyzer =
  process.env.ANALYZE === 'true'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@next/bundle-analyzer')({ enabled: true })
    : (config: NextConfig) => config;

/**
 * HTTP security headers applied to all responses.
 * Implements ISO 27001 A.13 (Communications Security) and A.14 (Secure Development).
 *
 * Content-Security-Policy: restricts which resources the browser may load.
 * Strict-Transport-Security: enforces HTTPS for 2 years including subdomains.
 * X-Frame-Options: prevents clickjacking by disallowing iframes.
 * X-Content-Type-Options: prevents MIME-type sniffing.
 * Referrer-Policy: limits referrer information sent to third parties.
 * Permissions-Policy: disables browser features not needed by BizzAssist.
 *
 * BIZZ-194: 'unsafe-eval' is NOT included in the global CSP.
 * Mapbox GL JS requires eval() for shader compilation, so it is added
 * only for the map routes (/dashboard/kort and /kort) via route-specific
 * headers below.
 */
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // 'unsafe-inline': required by Mapbox GL JS (inlines worker bootstrapping code) and Next.js
      // inline event handlers. Nonces are not currently viable because Mapbox injects scripts
      // dynamically at runtime without nonce support.
      // NOTE: 'unsafe-eval' is intentionally omitted here — it is only added for map routes.
      "script-src 'self' 'unsafe-inline' https://browser.sentry-cdn.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' https://fonts.gstatic.com",
      // Supabase + DAWA (Danmarks Adressers Web API) + Mapbox tile servers + Sentry
      "connect-src 'self' https://*.supabase.co https://*.supabase.io wss://*.supabase.co https://*.sentry.io https://o4511077193416704.ingest.de.sentry.io wss: https://api.dataforsyningen.dk https://*.mapbox.com https://events.mapbox.com",
      // Mapbox GL JS kræver blob: WebWorkers til tile-dekodning
      "worker-src blob: 'self'",
      "child-src blob: 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on',
  },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  devIndicators: false,
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
  },
  // pdfkit bruger __dirname til at finde font-filer — bundling bryder dette,
  // så vi loader pakken som native Node.js-modul uden transpilering.
  serverExternalPackages: ['pdfkit'],
  async headers() {
    const isProduction =
      process.env.VERCEL_ENV === 'production' ||
      (!!process.env.NEXT_PUBLIC_APP_URL &&
        process.env.NEXT_PUBLIC_APP_URL.includes('bizzassist.dk') &&
        !process.env.NEXT_PUBLIC_APP_URL.includes('test.bizzassist.dk'));

    // CSP with 'unsafe-eval' added — only for map routes that load Mapbox GL JS.
    // Mapbox GL JS uses eval() internally for WebGL shader compilation.
    // Scoping this to /dashboard/kort and /kort limits the attack surface.
    const mapCspValue = securityHeaders
      .find((h) => h.key === 'Content-Security-Policy')!
      .value.replace(
        "script-src 'self' 'unsafe-inline' https://browser.sentry-cdn.com",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://browser.sentry-cdn.com"
      );

    const mapHeaders = securityHeaders.map((h) =>
      h.key === 'Content-Security-Policy' ? { key: h.key, value: mapCspValue } : h
    );

    const headers: { source: string; headers: { key: string; value: string }[] }[] = [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
      {
        // Override CSP on map pages to allow 'unsafe-eval' needed by Mapbox GL JS.
        // BIZZ-194: unsafe-eval is only allowed on these two routes, not globally.
        source: '/dashboard/kort',
        headers: mapHeaders,
      },
      {
        source: '/kort',
        headers: mapHeaders,
      },
    ];

    // På non-prod (test, preview, localhost): tilføj X-Robots-Tag: noindex
    // så søgemaskiner ikke indekserer de offentlige SEO-sider.
    if (!isProduction) {
      headers.push({
        source: '/(ejendom|virksomhed)/(.*)',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      });
    }

    return headers;
  },
};

/**
 * Wraps the Next.js config with Sentry's build-time plugin.
 *
 * withSentryConfig does three things critical for BIZZ-125:
 *  1. Auto-instruments all API routes so uncaught errors are captured in Sentry
 *     without needing `captureException` in every route file.
 *  2. Uploads source maps to Sentry on each build (so stack traces are readable).
 *  3. Injects Sentry initialization into the server, edge, and client bundles.
 *
 * tunnelRoute: routes Sentry events through /monitoring so adblockers can't
 * block them. Matches the CSP connect-src allow-list in securityHeaders above.
 *
 * disableLogger: strips Sentry's verbose build-time logger from the production
 * bundle to reduce bundle size.
 */
export default withBundleAnalyzer(
  withSentryConfig(nextConfig, {
    org: 'bizzassist',
    project: 'bizzassist',
    // Silences the Sentry CLI output during builds — errors still surface via exit code
    silent: !process.env.CI,
    // Upload source maps only in CI/production — not during local dev
    sourcemaps: {
      disable: !process.env.CI,
    },
    // Route Sentry tunnel through our own domain (avoids adblocker blocking)
    tunnelRoute: '/monitoring',
    // Turbopack-compatible settings (deprecated webpack-only options removed)
    telemetry: false,
  })
);
