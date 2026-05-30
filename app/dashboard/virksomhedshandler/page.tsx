/**
 * Virksomhedshandler — M&A-radar med AI-værdiansættelse.
 *
 * BIZZ-1925: Feature-flag gated route. Kun synlig når
 * NEXT_PUBLIC_VIRKSOMHEDSHANDLER_ENABLED=true (test/dev).
 *
 * @module app/dashboard/virksomhedshandler/page
 */

import { redirect } from 'next/navigation';
import { isVirksomhedshandlerEnabled } from '@/app/lib/featureFlags';

export default function VirksomhedshandlerPage() {
  if (!isVirksomhedshandlerEnabled()) {
    redirect('/dashboard');
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-white text-2xl font-bold">Virksomhedshandler</h1>
      <p className="text-slate-400 text-sm">M&A-radar med AI-værdiansættelse. Under udvikling.</p>
      <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-8 text-center">
        <p className="text-slate-500">Denne funktion er under udvikling. Kom snart tilbage.</p>
      </div>
    </div>
  );
}
