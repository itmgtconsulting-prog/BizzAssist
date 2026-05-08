/**
 * Server entry for kreditvurdering analyse-modul.
 * BIZZ-1231: Bruger shared AnalyseModulLayout framework.
 */
import KreditvurderingClient from './KreditvurderingClient';

export const dynamic = 'force-dynamic';

export default function KreditvurderingPage() {
  return <KreditvurderingClient />;
}
