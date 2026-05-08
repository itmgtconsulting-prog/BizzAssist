/**
 * Server entry for due-diligence analyse-modul.
 * BIZZ-1231: Bruger shared AnalyseModulLayout framework.
 */
import DueDiligenceClient from './DueDiligenceClient';

export const dynamic = 'force-dynamic';

export default function DueDiligencePage() {
  return <DueDiligenceClient />;
}
