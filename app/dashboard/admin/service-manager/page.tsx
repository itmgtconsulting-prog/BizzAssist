/**
 * Server entry point for service-manager — forces dynamic rendering (lambda).
 */
import ServiceManagerClient from './ServiceManagerClient';

export const dynamic = 'force-dynamic';

export default function ServiceManagerPage() {
  return <ServiceManagerClient />;
}
