/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import VerifyEmailClient from './VerifyEmailClient';

export const dynamic = 'force-dynamic';

export default function VerifyEmailPage() {
  return <VerifyEmailClient />;
}
