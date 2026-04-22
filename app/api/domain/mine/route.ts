/**
 * GET /api/domain/mine — list domains the current user is a member of.
 *
 * BIZZ-711: Used by main nav to conditionally show Domain menu item.
 * Returns empty array if user has no domain memberships.
 *
 * @module api/domain/mine
 */

import { NextResponse } from 'next/server';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { listUserDomains } from '@/app/lib/domainAuth';

/**
 * GET /api/domain/mine
 */
export async function GET(): Promise<NextResponse> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const domains = await listUserDomains();
  return NextResponse.json(domains, {
    headers: { 'Cache-Control': 'private, max-age=300' },
  });
}
