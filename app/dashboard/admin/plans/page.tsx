/**
 * Server entry point for plans — forces dynamic rendering (lambda).
 */
import PlansClient from './PlansClient';

export const dynamic = 'force-dynamic';

export default function AdminPlansPage() {
  return <PlansClient />;
}
