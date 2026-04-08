/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import VerifiedPageClient from './VerifiedPageClient';

export const dynamic = 'force-dynamic';

export default function VerifiedPage() {
  return <VerifiedPageClient />;
}
