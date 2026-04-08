/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import PrivacyPageClient from './PrivacyPageClient';

export const dynamic = 'force-dynamic';

export default function PrivacyPage() {
  return <PrivacyPageClient />;
}
