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
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://browser.sentry-cdn.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "connect-src 'self' https://*.sentry.io https://o4511077193416704.ingest.de.sentry.io wss:",
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
  devIndicators: false,
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
