/**
 * Server entry point for service-management — forces dynamic rendering (lambda).
 */
import ServiceManagementClient from './ServiceManagementClient';

export const dynamic = 'force-dynamic';

export default function ServiceManagementPage() {
  return <ServiceManagementClient />;
}
