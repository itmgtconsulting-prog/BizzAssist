/**
 * BIZZ-625: Unified Operations Dashboard — /dashboard/admin/ops
 *
 * Admin-landing der giver overblik over alle ops-områder i én visning:
 * Infrastructure-probes, cron-status, service-manager scans og åbne
 * issues. Hver tile drill-downer til det eksisterende dedikerede
 * dashboard uden at forlade admin-konteksten.
 *
 * Server entry — forcerer dynamic rendering så hver ops-tile henter
 * friske data ved hvert besøg.
 */

import OpsDashboardClient from './OpsDashboardClient';

export const dynamic = 'force-dynamic';

export default function OpsDashboardPage() {
  return <OpsDashboardClient />;
}
