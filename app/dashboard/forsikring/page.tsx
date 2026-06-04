/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * Forsikringsmodulets liste-side: viser policer + pending uploads + KPI-tæller.
 * BIZZ-1988: Server-side modul-håndhævelse via ServerModuleGate.
 */
import ServerModuleGate from '@/app/components/analyse/ServerModuleGate';
import ForsikringPageClient from './ForsikringPageClient';

export const dynamic = 'force-dynamic';

export default function ForsikringPage() {
  return (
    <ServerModuleGate moduleId="forsikring">
      <ForsikringPageClient />
    </ServerModuleGate>
  );
}
