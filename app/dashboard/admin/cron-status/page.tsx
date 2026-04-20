/**
 * BIZZ-621: Cron Status Dashboard — /dashboard/admin/cron-status
 *
 * Server entry. Tvinger dynamic rendering så Supabase cron_heartbeats-data
 * altid hentes friskt ved hvert besøg (ingen ISR-caching af status).
 */

import CronStatusClient from './CronStatusClient';

export const dynamic = 'force-dynamic';

export default function CronStatusPage() {
  return <CronStatusClient />;
}
