/**
 * Server entry point for security — forces dynamic rendering (lambda).
 */
import SecurityClient from './SecurityClient';

export const dynamic = 'force-dynamic';

export default function AdminSecurityPage() {
  return <SecurityClient />;
}
