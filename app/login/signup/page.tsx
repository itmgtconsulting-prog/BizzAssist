/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import SignupClient from './SignupClient';

export const dynamic = 'force-dynamic';

export default function SignupPage() {
  return <SignupClient />;
}
