/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import OnboardingClient from './OnboardingClient';

export const dynamic = 'force-dynamic';

export default function OnboardingPage() {
  return <OnboardingClient />;
}
