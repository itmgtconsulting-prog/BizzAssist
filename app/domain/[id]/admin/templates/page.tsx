/**
 * Templates admin list — /domain/[id]/admin/templates
 *
 * BIZZ-721: Admin list of all templates in the domain. Upload opens an
 * inline file-picker that POSTs to /api/domain/:id/templates (BIZZ-707).
 */

import TemplatesListClient from './TemplatesListClient';

export default async function TemplatesListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplatesListClient domainId={id} />;
}
