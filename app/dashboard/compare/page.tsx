/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import ComparePageClient from './ComparePageClient';

export const dynamic = 'force-dynamic';

export default function ComparePage() {
  return <ComparePageClient />;
}
