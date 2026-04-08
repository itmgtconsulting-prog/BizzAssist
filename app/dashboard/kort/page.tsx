/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import KortPageClient from './KortPageClient';

export const dynamic = 'force-dynamic';

export default function KortPage() {
  return <KortPageClient />;
}
