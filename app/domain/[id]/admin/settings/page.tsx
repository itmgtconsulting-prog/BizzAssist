/**
 * Domain Admin Settings page — /domain/[id]/admin/settings
 *
 * BIZZ-706: Server component for the settings editor.
 * Role + feature-flag check happens in the parent layout.
 *
 * @module app/domain/[id]/admin/settings/page
 */

import DomainSettingsClient from './DomainSettingsClient';

export default async function DomainSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DomainSettingsClient domainId={id} />;
}
