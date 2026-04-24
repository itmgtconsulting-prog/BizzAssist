/**
 * Team invitation accept-side — /team/accept?token=...
 *
 * BIZZ-271: Landing-side fra invitation-email. Hvis user ikke er logget
 * ind, redirectes til /login med return-URL. Ellers kaldes POST /api/team/accept
 * som verificerer token + email-match + udløb og opretter tenant_membership.
 *
 * @module app/team/accept/page
 */

import AcceptClient from './AcceptClient';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function TeamAcceptPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  return <AcceptClient token={token ?? ''} />;
}
