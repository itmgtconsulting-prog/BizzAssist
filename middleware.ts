/**
 * Next.js middleware — Content-Security-Policy med per-request nonce (BIZZ-2244).
 *
 * BIZZ-209 flyttede CSP hertil (nonce-baseret, kan ikke ligge statisk i
 * next.config.ts fordi nonce skal vaere unik pr. request). Filen forsvandt paa et
 * tidspunkt (regression) → prod serverede INGEN CSP-header. Denne genindfoerer den.
 *
 * ROLLOUT (max sikkerhed): headeren serveres foreloebig som
 * `Content-Security-Policy-Report-Only`. Report-Only BLOKERER intet — den
 * rapporterer blot hvad der VILLE blive blokeret. Det lukker "ingen CSP"-hullet
 * med observability uden risiko for at braekke inline-scripts/3.-parts-ressourcer.
 * Naar rapporterne er rene flyttes headeren til den haandhaevende
 * `Content-Security-Policy` (foelge-ticket). Nonce propageres allerede til Next's
 * egne scripts nu, saa skiftet bliver gnidningsfrit.
 *
 * Rate-limiting ligger IKKE her: det er per-route via app/lib/rateLimit.ts
 * (BIZZ-2245) — middleware bruges kun til CSP.
 */
import { NextRequest, NextResponse } from 'next/server';

/** Om CSP haandhaeves (true) eller kun rapporteres (false). Report-Only foerst. */
const CSP_ENFORCE = false;

/**
 * Byg CSP-direktiv-strengen med den givne nonce.
 *
 * connect-src daekker de tjenester browseren faktisk kalder direkte: Supabase
 * (auth/realtime/storage), Mapbox (tiles/events), Stripe (betaling) og Sentry
 * (via same-origin /monitoring-tunnel → 'self'). script/style holdes stramme via
 * nonce + strict-dynamic; style-src tillader 'unsafe-inline' da Tailwind/Mapbox
 * injicerer inline styles (styles kan ikke misbruges til exfiltrering som scripts).
 *
 * @param nonce - per-request base64-nonce
 * @returns CSP-header-vaerdi
 */
function buildCsp(nonce: string): string {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline' https://api.mapbox.com`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${supabase} https://*.supabase.co https://api.mapbox.com https://events.mapbox.com https://api.stripe.com`,
    `frame-src 'self' https://js.stripe.com https://hooks.stripe.com`,
    `worker-src 'self' blob:`,
    `child-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');
}

/**
 * Saetter CSP-header (med nonce) paa hver navigations-request. Nonce videregives
 * til Next via `x-nonce` request-header saa framework-scripts faar nonce'en.
 *
 * @param request - indkommende request
 * @returns response med CSP- + nonce-headers
 */
export function middleware(request: NextRequest): NextResponse {
  // Generér en kryptografisk nonce (Web Crypto — tilgaengelig i edge-runtime).
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);

  // Videregiv nonce til app'en via request-header (Next tilfoejer den til egne scripts).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  const headerName = CSP_ENFORCE
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
  response.headers.set(headerName, csp);
  return response;
}

/**
 * Matcher: koer paa alle sider MEN spring statiske assets + billed-optimering +
 * Sentry-tunnellen over (de behoever ingen CSP og ville blot koste latenstid).
 */
export const config = {
  matcher: [
    {
      source:
        '/((?!_next/static|_next/image|favicon.ico|monitoring|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
    },
  ],
};
