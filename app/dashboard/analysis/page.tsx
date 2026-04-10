/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * AI analysis is only available when NEXT_PUBLIC_AI_ENABLED=true (dev only).
 */
import { redirect } from 'next/navigation';
import AnalysisPageClient from './AnalysisPageClient';

export const dynamic = 'force-dynamic';

export default function AnalysisPage() {
  if (process.env.NEXT_PUBLIC_AI_ENABLED !== 'true') {
    redirect('/dashboard');
  }
  return <AnalysisPageClient />;
}
