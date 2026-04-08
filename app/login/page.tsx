/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import LoginClient from './LoginClient';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return <LoginClient />;
}
