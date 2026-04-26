/**
 * Template editor — /domain/[id]/admin/templates/[templateId]
 *
 * BIZZ-721: Five-tab editor. Live tabs: Metadata, Instructions, Examples,
 * Placeholders, Versions.
 * BIZZ-787: Renders the editor inside a resizable split-view with the
 * documents panel on the right so documents (AI background knowledge)
 * live in the context of the specific template.
 */

import { TemplateEditorSplitView } from './TemplateEditorSplitView';

export default async function TemplateEditorPage({
  params,
}: {
  params: Promise<{ id: string; templateId: string }>;
}) {
  const { id, templateId } = await params;
  return <TemplateEditorSplitView domainId={id} templateId={templateId} />;
}
