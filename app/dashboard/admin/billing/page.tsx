/**
 * Server entry point for billing — forces dynamic rendering (lambda).
 */
import BillingClient from './BillingClient';

export const dynamic = 'force-dynamic';

export default function AdminBillingPage() {
  return <BillingClient />;
}
