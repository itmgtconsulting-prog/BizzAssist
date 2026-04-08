/**
 * Server entry point — forces dynamic rendering so Vercel generates a lambda for this route.
 */
import { Suspense } from 'react';
import MfaClient from './MfaClient';

export const dynamic = 'force-dynamic';

export default function MfaPage() {
  return (
    <Suspense>
      <MfaClient />
    </Suspense>
  );
}
