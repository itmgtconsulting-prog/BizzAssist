/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import UniversalSearchPageClient from './UniversalSearchPageClient';

export const dynamic = 'force-dynamic';

export default function UniversalSearchPage() {
  return <UniversalSearchPageClient />;
}
