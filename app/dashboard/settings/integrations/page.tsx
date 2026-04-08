/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import IntegrationsPageClient from './IntegrationsPageClient';

export const dynamic = 'force-dynamic';

export default function IntegrationsPage() {
  return <IntegrationsPageClient />;
}
