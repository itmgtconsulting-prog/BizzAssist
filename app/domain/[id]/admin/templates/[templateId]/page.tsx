/**
 * Template editor — /domain/[id]/admin/templates/[templateId]
 *
 * BIZZ-721: Five-tab editor. Live tabs: Metadata, Instructions, Examples,
 * Placeholders. Fil-preview and Versions are deferred to follow-ups.
 */

import TemplateEditorClient from './TemplateEditorClient';

export default async function TemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string; templateId: string }>;
}) {
  const { id, templateId } = await params;
  return <TemplateEditorClient domainId={id} templateId={templateId} />;
}
