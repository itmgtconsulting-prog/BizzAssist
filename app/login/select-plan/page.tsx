/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import SelectPlanClient from './SelectPlanClient';

export const dynamic = 'force-dynamic';

export default function SelectPlanPage() {
  return <SelectPlanClient />;
}
