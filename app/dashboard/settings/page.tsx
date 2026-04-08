/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import SettingsPageClient from './SettingsPageClient';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return <SettingsPageClient />;
}
