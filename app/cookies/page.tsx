/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import CookiesPageClient from './CookiesPageClient';

export const dynamic = 'force-dynamic';

export default function CookiesPage() {
  return <CookiesPageClient />;
}
