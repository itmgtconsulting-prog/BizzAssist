/**
 * Admin AI Media Agents — server entry point.
 * Forces dynamic rendering so Vercel generates a lambda for this route.
 */
import AiMediaAgentsClient from './AiMediaAgentsClient';

export const dynamic = 'force-dynamic';

export default function AdminAiMediaAgentsPage() {
  return <AiMediaAgentsClient />;
}
