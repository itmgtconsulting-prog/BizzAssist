/**
 * AI Analyse — /dashboard/analyse/ai
 *
 * BIZZ-1037: Refaktoreret fra /dashboard/analysis.
 * Importerer den eksisterende AnalysisPageClient.
 */
import AnalysisPageClient from '@/app/dashboard/analysis/AnalysisPageClient';

export const dynamic = 'force-dynamic';

/**
 * AI Analyse side — wrapper for eksisterende AnalysisPageClient.
 */
export default function AnalyseAIPage() {
  return <AnalysisPageClient />;
}
