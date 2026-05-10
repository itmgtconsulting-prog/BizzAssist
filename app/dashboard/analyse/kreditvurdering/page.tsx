/**
 * Server entry for kreditvurdering analyse-modul.
 * BIZZ-1240: Wrapped i AnalyseModuleGuard for feature flag check.
 */
import KreditvurderingClient from './KreditvurderingClient';
import AnalyseModuleGuard from '@/app/components/analyse/AnalyseModuleGuard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <AnalyseModuleGuard moduleId="kreditvurdering">
      <KreditvurderingClient />
    </AnalyseModuleGuard>
  );
}
