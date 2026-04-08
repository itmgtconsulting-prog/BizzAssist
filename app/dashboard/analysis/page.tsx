/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import AnalysisPageClient from './AnalysisPageClient';

export const dynamic = 'force-dynamic';

export default function AnalysisPage() {
  return <AnalysisPageClient />;
}
