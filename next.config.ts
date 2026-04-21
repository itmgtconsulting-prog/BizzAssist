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
 * Content-Security-Policy is NOT here — it is set dynamically per request in
 * middleware.ts with a unique nonce (BIZZ-209). Only static headers remain.
 *
 * Strict-Transport-Security: enforces HTTPS for 2 years including subdomains.
 * X-Frame-Options: prevents clickjacking by disallowing iframes.
 * X-Content-Type-Options: prevents MIME-type sniffing.
 * Referrer-Policy: limits referrer information sent to third parties.
 * Permissions-Policy: disables browser features not needed by BizzAssist.
 */
// Lighthouse CI kører mod http://localhost:3000 uden TLS. Når HSTS-headeren
// sendes (selv over loopback) får Chrome en "interstitial" der forhindrer
// siden i at loade. Skip HSTS når LIGHTHOUSE_CI=1 er sat af workflow'en.
const isLighthouseCi = process.env.LIGHTHOUSE_CI === '1';

const securityHeaders = [
  ...(isLighthouseCi
    ? []
    : [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ]),
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

    // CSP is handled dynamically in middleware.ts (BIZZ-209 — nonce-based).
    // Only static security headers are applied here.
    const headers: { source: string; headers: { key: string; value: string }[] }[] = [
      {
        source: '/(.*)',
        headers: securityHeaders,
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
    silent: !process.env.CI,
    sourcemaps: {
      disable: !process.env.CI,
    },
    tunnelRoute: '/monitoring',
    telemetry: false,
    // Disable auto-wrapping of page/layout/error components with Sentry error
    // boundaries. Fixes useContext crash during prerender of _global-error.
    // Error capturing is handled by ErrorBoundary component + instrumentation.ts.
    autoInstrumentAppDirectory: false,
  })
);
