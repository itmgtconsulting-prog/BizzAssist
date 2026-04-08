/**
 * Server entry point for analytics — forces dynamic rendering (lambda).
 */
import AnalyticsClient from './AnalyticsClient';

export const dynamic = 'force-dynamic';

export default function AdminAnalyticsPage() {
  return <AnalyticsClient />;
}
