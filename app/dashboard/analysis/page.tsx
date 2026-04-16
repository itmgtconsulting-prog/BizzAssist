/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * BIZZ-236: AI access is gated by subscription plan, not env var.
 * BIZZ-341: Hidden in production — only visible on test.bizzassist.dk and localhost.
 */
import { redirect } from 'next/navigation';
import AnalysisPageClient from './AnalysisPageClient';

export const dynamic = 'force-dynamic';

export default function AnalysisPage() {
  const isDevOrTest =
    process.env.NEXT_PUBLIC_APP_URL?.includes('test.bizzassist.dk') ||
    process.env.NODE_ENV === 'development';

  if (!isDevOrTest) {
    redirect('/dashboard');
  }

  return <AnalysisPageClient />;
}
