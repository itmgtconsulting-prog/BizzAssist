/**
 * BIZZ-2244: Regressionstest for public-route CSP.
 *
 * proxy.ts springer public/SEO-routes over (ISR-cache) → de fik ingen CSP. Denne
 * statiske policy (next.config.ts) lukker hullet. Testen fejler hvis CSP-hullet
 * genopstaar (fx forsiden mister CSP igen som i BIZZ-209-regressionen).
 */
import { describe, it, expect } from 'vitest';
import { PUBLIC_STATIC_CSP, PUBLIC_CSP_SOURCES } from '@/app/lib/security/publicCsp';

describe('BIZZ-2244 public static CSP', () => {
  it('daekker forsiden (/) — ticketens konkrete fund', () => {
    expect(PUBLIC_CSP_SOURCES).toContain('/');
  });

  it('daekker de ISR-cachede public SEO-routes', () => {
    expect(PUBLIC_CSP_SOURCES).toContain('/ejendom/:path*');
    expect(PUBLIC_CSP_SOURCES).toContain('/virksomhed/:path*');
  });

  it('har de haardt beskyttende direktiver (clickjacking/injection)', () => {
    expect(PUBLIC_STATIC_CSP).toContain("frame-ancestors 'none'");
    expect(PUBLIC_STATIC_CSP).toContain("base-uri 'self'");
    expect(PUBLIC_STATIC_CSP).toContain("form-action 'self'");
    expect(PUBLIC_STATIC_CSP).toContain("default-src 'self'");
  });

  it('tillader de ressourcer public-sider faktisk bruger (supabase/mapbox/sentry)', () => {
    expect(PUBLIC_STATIC_CSP).toContain('supabase.co');
    expect(PUBLIC_STATIC_CSP).toContain('mapbox.com');
    expect(PUBLIC_STATIC_CSP).toContain('sentry-cdn.com');
  });

  it('upgrader usikre requests til HTTPS', () => {
    expect(PUBLIC_STATIC_CSP).toContain('upgrade-insecure-requests');
  });
});
