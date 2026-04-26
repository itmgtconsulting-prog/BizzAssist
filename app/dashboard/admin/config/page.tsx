/**
 * Server entry point for /dashboard/admin/config.
 *
 * BIZZ-419: Admin system-config UI. Force-dynamic fordi siden viser
 * admin-ændringer realtime og aldrig bør cache'es.
 */
import ConfigClient from './ConfigClient';

export const dynamic = 'force-dynamic';

export default function AdminConfigPage() {
  return <ConfigClient />;
}
