/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import MfaEnrollClient from './MfaEnrollClient';

export const dynamic = 'force-dynamic';

export default function MfaEnrollPage() {
  return <MfaEnrollClient />;
}
