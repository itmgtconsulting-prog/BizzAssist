/**
 * GET /api/vurderingsrapport/sager/[sagId]/eksport?format=docx
 *
 * BIZZ-1642: DOCX eksport af vurderingsrapport.
 * Bygger Word-dokument fra rapport-tabs (vurdering_rapport_tabs).
 *
 * @module api/vurderingsrapport/sager/[sagId]/eksport
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { logger } from '@/app/lib/logger';

export const maxDuration = 30;

/** Tab-labels for rapport-sektioner */
const TAB_LABELS: Record<string, string> = {
  identifikation: '1. Identifikation',
  bygningsdata: '2. Bygningsdata',
  energi: '3. Energi',
  vurdering_skat: '4. Vurdering & Skat',
  tinglysning: '5. Tinglysning & Ejerskab',
  servitutter: '6. Servitutter',
  beliggenhed: '7. Beliggenhed',
  risiko: '8. Risiko & Økonomi',
};

/** XML-escape */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Simpel paragraph */
const p = (text: string, opts?: { bold?: boolean; color?: string; size?: number }) => {
  const rpr: string[] = [];
  if (opts?.bold) rpr.push('<w:b/><w:bCs/>');
  if (opts?.color) rpr.push(`<w:color w:val="${opts.color}"/>`);
  if (opts?.size) rpr.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  return `<w:p><w:r>${rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
};

const heading = (text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

const spacer = () => '<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>';

/**
 * Render tab-indhold til OOXML paragraphs.
 */
function renderTabContent(indhold: Record<string, unknown>): string[] {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(indhold)) {
    if (val === null || val === undefined) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      parts.push(p(`${key}:`, { bold: true, color: '334155' }));
      for (const item of val) {
        if (typeof item === 'object' && item !== null) {
          const entries = Object.entries(item as Record<string, unknown>)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}: ${v}`)
            .join(' · ');
          parts.push(p(`  ${entries}`, { color: '64748b' }));
        } else {
          parts.push(p(`  ${String(item)}`, { color: '64748b' }));
        }
      }
    } else if (typeof val === 'object') {
      parts.push(p(`${key}:`, { bold: true, color: '334155' }));
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (v != null) parts.push(p(`  ${k}: ${v}`, { color: '64748b' }));
      }
    } else {
      parts.push(p(`${key}: ${String(val)}`, { color: '1e293b' }));
    }
  }
  return parts;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sagId: string }> }
): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { sagId } = await params;

  try {
    const schemaName = await getTenantSchemaName(auth.tenantId);
    if (!schemaName) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (admin as any).schema(schemaName);

    const [sagResult, tabsResult] = await Promise.all([
      db
        .from('vurdering_sager')
        .select('*')
        .eq('id', sagId)
        .eq('tenant_id', auth.tenantId)
        .maybeSingle(),
      db.from('vurdering_rapport_tabs').select('*').eq('sag_id', sagId).order('tab_key'),
    ]);

    if (!sagResult.data) return NextResponse.json({ error: 'Sag ikke fundet' }, { status: 404 });

    const sag = sagResult.data;
    const tabs = (tabsResult.data ?? []) as Array<{
      tab_key: string;
      indhold: Record<string, unknown>;
    }>;

    // Byg DOCX body
    const body: string[] = [];
    body.push(p('VURDERINGSRAPPORT', { bold: true, color: '1e40af', size: 48 }));
    body.push(spacer());
    body.push(p(String(sag.kunde_navn ?? sag.kunde_id), { bold: true, color: '1e293b', size: 36 }));
    if (sag.ejendom_adresse)
      body.push(p(String(sag.ejendom_adresse), { color: '64748b', size: 24 }));
    body.push(
      p(
        `Sagsnr: ${sag.sag_nummer} · Dato: ${new Date(sag.created_at).toLocaleDateString('da-DK')}`,
        { color: '64748b', size: 20 }
      )
    );
    body.push(spacer());

    // Render tabs
    const tabOrder = [
      'identifikation',
      'bygningsdata',
      'energi',
      'vurdering_skat',
      'tinglysning',
      'servitutter',
      'beliggenhed',
      'risiko',
    ];
    for (const tabKey of tabOrder) {
      const tab = tabs.find((t) => t.tab_key === tabKey);
      body.push(heading(TAB_LABELS[tabKey] ?? tabKey));
      if (tab?.indhold) {
        body.push(...renderTabContent(tab.indhold));
      } else {
        body.push(p('Ingen data tilgængelig.', { color: '94a3b8' }));
      }
      body.push(spacer());
    }

    // Disclaimer
    body.push(
      p(
        'Disclaimer: Denne rapport er udarbejdet automatisk af BizzAssist baseret på offentlige registre og uploadede dokumenter. Den udgør ikke en autoriseret vurdering.',
        { color: '64748b', size: 18 }
      )
    );

    // Build DOCX
    const { default: PizZip } = await import('pizzip');

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="300" w:after="120"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1e40af"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
</w:styles>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body.join('\n')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const zip = new PizZip();
    zip.file('[Content_Types].xml', contentTypesXml);
    zip.file('_rels/.rels', relsXml);
    zip.file('word/document.xml', documentXml);
    zip.file('word/styles.xml', stylesXml);
    zip.file('word/_rels/document.xml.rels', wordRelsXml);

    const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    const slug = (String(sag.sag_nummer) ?? 'rapport').toLowerCase();

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="vurderingsrapport-${slug}.docx"`,
      },
    });
  } catch (err) {
    logger.error('[vurdering/eksport]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
