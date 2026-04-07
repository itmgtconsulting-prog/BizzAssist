import type { NextConfig } from 'next';

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
 */
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // 'unsafe-inline': required by Mapbox GL JS (inlines worker bootstrapping code) and Next.js
      // inline event handlers. Nonces are not currently viable because Mapbox injects scripts
      // dynamically at runtime without nonce support.
      // 'unsafe-eval': required by Mapbox GL JS (uses eval() internally for shader compilation).
      // Both directives should be removed if/when Mapbox drops these requirements.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://browser.sentry-cdn.com",
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
    return [
      {
        // Apply security headers to all routes
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
