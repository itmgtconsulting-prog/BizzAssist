/**
 * Domain-member layout — gates all /domain/[id]/* routes to members.
 *
 * BIZZ-712: The user-facing domain dashboard (cases list, new-case, case-doc
 * upload) requires at minimum `assertDomainMember`. The nested /admin/ routes
 * additionally assert admin in their own layout, so the stricter scope still
 * applies there.
 *
 * Non-members hit 404 (invisible domain — can't confirm/deny existence).
 * Feature-flag-gated via isDomainFeatureEnabled().
 *
 * @module app/domain/[id]/layout
 */

import { notFound } from 'next/navigation';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { resolveDomainId } from '@/app/lib/domainAuth';

export default async function DomainMemberLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  if (!isDomainFeatureEnabled()) notFound();

  const { id } = await params;
  const ctx = await resolveDomainId(id);
  if (!ctx) notFound();

  return <>{children}</>;
}
