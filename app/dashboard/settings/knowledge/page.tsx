/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import KnowledgePageClient from './KnowledgePageClient';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  return <KnowledgePageClient />;
}
