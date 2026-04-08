/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import ForgotPasswordClient from './ForgotPasswordClient';

export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  return <ForgotPasswordClient />;
}
