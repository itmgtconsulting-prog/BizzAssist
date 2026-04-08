/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import SecuritySettingsPageClient from './SecuritySettingsPageClient';

export const dynamic = 'force-dynamic';

export default function SecuritySettingsPage() {
  return <SecuritySettingsPageClient />;
}
