/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * BIZZ-236: AI access is gated by subscription plan, not env var.
 */
import AnalysisPageClient from './AnalysisPageClient';

export const dynamic = 'force-dynamic';

export default function AnalysisPage() {
  return <AnalysisPageClient />;
}
