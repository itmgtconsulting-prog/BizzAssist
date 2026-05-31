/**
 * Server entry for virksomhedshandler analyse-modul.
 *
 * BIZZ-1929: M&A-radar med AI-værdiansættelse. Feature-flag gated.
 *
 * @module app/dashboard/analyse/virksomhedshandler/page
 */

import { redirect } from 'next/navigation';
import { isVirksomhedshandlerEnabled } from '@/app/lib/featureFlags';
import VirksomhedshandlerClient from './VirksomhedshandlerClient';

export const dynamic = 'force-dynamic';

/**
 * VirksomhedshandlerPage — M&A-radar side.
 * Redirecter til dashboard hvis feature flag er slukket.
 */
export default function VirksomhedshandlerPage() {
  if (!isVirksomhedshandlerEnabled()) {
    redirect('/dashboard');
  }

  return <VirksomhedshandlerClient />;
}
