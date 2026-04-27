/**
 * BIZZ-987: Data Sync Status Dashboard — /dashboard/admin/sync-status
 *
 * Server entry. Tvinger dynamic rendering så sync-status altid hentes friskt.
 */

import SyncStatusClient from './SyncStatusClient';

export const dynamic = 'force-dynamic';

export default function SyncStatusPage() {
  return <SyncStatusClient />;
}
