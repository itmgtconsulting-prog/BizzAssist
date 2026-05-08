/**
 * Server entry for inkasso-aktivsoegning analyse-modul.
 * BIZZ-1231: Bruger shared AnalyseModulLayout framework.
 */
import InkassoAktivsoegningClient from './InkassoAktivsoegningClient';

export const dynamic = 'force-dynamic';

export default function InkassoAktivsoegningPage() {
  return <InkassoAktivsoegningClient />;
}
