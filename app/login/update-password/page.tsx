/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import UpdatePasswordClient from './UpdatePasswordClient';

export const dynamic = 'force-dynamic';

export default function UpdatePasswordPage() {
  return <UpdatePasswordClient />;
}
