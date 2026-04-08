/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 */
import DashboardPageClient from './DashboardPageClient';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return <DashboardPageClient />;
}
