/**
 * Server entry for kommune-energi analyse-modul.
 * BIZZ-1231: Bruger shared AnalyseModulLayout framework.
 */
import KommuneEnergiClient from './KommuneEnergiClient';

export const dynamic = 'force-dynamic';

export default function KommuneEnergiPage() {
  return <KommuneEnergiClient />;
}
