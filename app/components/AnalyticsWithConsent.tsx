/**
 * AnalyticsWithConsent — client-side gated Vercel Analytics loader.
 *
 * Mounts <Analytics /> only when the user has explicitly accepted cookies
 * via the GDPR banner. Reads the consent state client-side so the root
 * layout does not need to call `headers()` / `cookies()`, which would
 * force the entire app (including public SEO routes) into dynamic mode
 * and break ISR / Google indexing.
 *
 * BIZZ-1782 / BIZZ-1893 follow-up: Public /ejendom/* and /virksomhed/*
 * routes returned `Cache-Control: no-store` despite `export const revalidate`
 * because root layout's `await headers()` opted the whole tree into
 * force-dynamic. Moving the consent check here restores ISR.
 *
 * @module app/components/AnalyticsWithConsent
 */

'use client';

import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/next';
import { getConsentClient } from '@/app/lib/cookieConsent';

/**
 * Renders Vercel Analytics only after the user has accepted cookies.
 *
 * Re-evaluates consent on the `bizzassist:consent-changed` custom event so
 * the script mounts immediately when the user clicks "Accept" in the
 * cookie banner (no full page reload required).
 *
 * @returns `<Analytics />` when consent is granted, otherwise `null`.
 */
export default function AnalyticsWithConsent() {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const evaluate = () => setAllowed(getConsentClient() === 'accepted');
    evaluate();
    window.addEventListener('bizzassist:consent-changed', evaluate);
    return () => window.removeEventListener('bizzassist:consent-changed', evaluate);
  }, []);

  return allowed ? <Analytics /> : null;
}
