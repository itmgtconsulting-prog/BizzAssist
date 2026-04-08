/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import TermsPageClient from './TermsPageClient';

export const dynamic = 'force-dynamic';

export default function TermsPage() {
  return <TermsPageClient />;
}
