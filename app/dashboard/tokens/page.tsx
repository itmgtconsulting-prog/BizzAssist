/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import TokensPageClient from './TokensPageClient';

export const dynamic = 'force-dynamic';

export default function TokensPage() {
  return <TokensPageClient />;
}
