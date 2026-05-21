/**
 * GET /api/vurderingsrapport/sager/[sagId]/eksport?format=docx
 *
 * BIZZ-1642 + BIZZ-1741: DOCX eksport af vurderingsrapport i DLR-format.
 *
 * Bygger struktureret Word-dokument fra rapport-tabs med:
 * - Forside med kunde, sagsnr, ejendomsadresse
 * - Tabelformaterede sektioner for bygningsdata, ejere, handler, haeftelser
 * - Lejevaerdiberegnings-kaede for vurdering & skat
 * - Referenceejendomme med kvm-priser
 * - AI-genereret prosa (hvis tilgaengelig)
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
  energi: '3. Energi & Miljø',
  vurdering_skat: '4. Vurdering & Skat',
  tinglysning: '5. Tinglysning & Ejerskab',
  servitutter: '6. Servitutter',
  beliggenhed: '7. Beliggenhed',
  risiko: '8. Risiko & Reference',
};

// ─── OOXML helpers ──────────────────────────────────────────────────────────

/** XML-escape */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Paragraph */
const p = (text: string, opts?: { bold?: boolean; color?: string; size?: number }) => {
  const rpr: string[] = [];
  if (opts?.bold) rpr.push('<w:b/><w:bCs/>');
  if (opts?.color) rpr.push(`<w:color w:val="${opts.color}"/>`);
  if (opts?.size) rpr.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  return `<w:p><w:r>${rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
};

const heading = (text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

const subheading = (text: string) =>
  `<w:p><w:pPr><w:spacing w:before="200" w:after="60"/></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:color w:val="334155"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

const spacer = () => '<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>';

/** Format DKK */
function fmtDkk(n: unknown): string {
  if (n == null || typeof n !== 'number') return '–';
  return n.toLocaleString('da-DK') + ' DKK';
}

/** Format date */
function fmtDate(d: unknown): string {
  if (!d || typeof d !== 'string') return '–';
  try {
    return new Date(d).toLocaleDateString('da-DK');
  } catch {
    return d;
  }
}

/** Field row: label + value */
const field = (label: string, value: unknown) => {
  const v = value == null || value === '' ? '–' : String(value);
  return p(`${label}: ${v}`, { color: '1e293b' });
};

/** Build OOXML table from headers + rows */
function table(headers: string[], rows: string[][]): string {
  const colW = Math.floor(9000 / headers.length);
  const hCells = headers
    .map(
      (h) =>
        `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/><w:shd w:val="clear" w:fill="1e293b"/></w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="e2e8f0"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(h)}</w:t></w:r></w:p></w:tc>`
    )
    .join('');
  const dataRows = rows
    .map(
      (row) =>
        `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`
    )
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="334155"/><w:bottom w:val="single" w:sz="4" w:color="334155"/><w:insideH w:val="single" w:sz="4" w:color="475569"/></w:tblBorders></w:tblPr><w:tr>${hCells}</w:tr>${dataRows}</w:tbl>`;
}

// ─── Per-tab DOCX renderers ────────────────────────────────────────────────

/** Extract data and AI sections from tab content. */
function extractParts(indhold: Record<string, unknown>) {
  if (indhold.data && typeof indhold.data === 'object') {
    return {
      data: indhold.data as Record<string, unknown>,
      ai: (indhold.ai as Record<string, string>) ?? null,
    };
  }
  return { data: indhold, ai: null };
}

/** Render AI sections as paragraphs. */
function renderAi(ai: Record<string, string> | null): string[] {
  if (!ai) return [];
  return Object.entries(ai)
    .filter(([, v]) => v && typeof v === 'string')
    .flatMap(([, v]) => [p(v, { color: '334155' }), spacer()]);
}

function renderIdentifikation(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  return [
    field('Adresse', data.adresse),
    field('BFE-nummer', data.bfe),
    field('Matrikel', data.matrikelnr),
    field('Ejerlav', data.ejerlavsnavn),
    field('Kommune', data.kommune),
    field('Region', data.region),
    field('Zone', data.zone),
    field('Ejerforhold', data.ejerforholdskode),
    field('Anvendelse', data.bygningsanvendelse),
    field('Juridisk kategori', data.juridiskKategori),
    ...renderAi(ai),
  ];
}

function renderBygningsdata(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  const rows = [
    ['Opførelsesår', String(data.opfoerelsesaar ?? '–')],
    ['Antal etager', String(data.antalEtager ?? '–')],
    ['Bebygget areal', data.bebyggetAreal ? `${data.bebyggetAreal} m²` : '–'],
    ['Boligareal', data.samletBoligareal ? `${data.samletBoligareal} m²` : '–'],
    ['Erhvervsareal', data.samletErhvervsareal ? `${data.samletErhvervsareal} m²` : '–'],
    ['Grundareal', data.grundareal ? `${data.grundareal} m²` : '–'],
    ['Tagmateriale', String(data.tagdaekningsmateriale ?? '–')],
    ['Ydervæg', String(data.ydervaegMateriale ?? '–')],
    ['Bevaringsværdighed', String(data.bevaringsvaerdighed ?? '–')],
  ];
  return [table(['Egenskab', 'Værdi'], rows), ...renderAi(ai)];
}

function renderEnergi(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  return [
    field('Energimærke', data.energimaerke),
    field('Dato', fmtDate(data.energimaerkeDato)),
    field('Varmeinstallation', data.opvarmning),
    field('Opvarmningsmiddel', data.opvarmningsmiddel),
    field('Supplerende varme', data.supplerendeVarme),
    field('Vandforsyning', data.vandforsyning),
    field('Afløbsforhold', data.afloebsforhold),
    ...renderAi(ai),
  ];
}

function renderVurderingSkat(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  const rows = [
    ['Ejendomsværdi', fmtDkk(data.ejendomsvaerdi)],
    ['Grundværdi', fmtDkk(data.grundvaerdi)],
    ['Afgiftspligtig ejendomsværdi', fmtDkk(data.afgiftspligtigEjendomsvaerdi)],
    ['Afgiftspligtig grundværdi', fmtDkk(data.afgiftspligtigGrundvaerdi)],
    ['Grundskyldspromille', data.grundskyldspromille ? `${data.grundskyldspromille} ‰` : '–'],
    ['Estimeret grundskyld', fmtDkk(data.estimeretGrundskyld)],
    ['Vurderingsår', String(data.vurderingsaar ?? '–')],
  ];
  return [table(['Post', 'Beløb'], rows), ...renderAi(ai)];
}

function renderTinglysning(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  const parts: string[] = [];

  // Ejere
  const ejere = (data.ejere ?? []) as Array<Record<string, unknown>>;
  if (ejere.length > 0) {
    parts.push(subheading('Adkomst'));
    parts.push(
      table(
        ['Navn', 'CVR', 'Type', 'Andel'],
        ejere.map((e) => [
          String(e.navn ?? '–'),
          String(e.cvr ?? '–'),
          String(e.type ?? '–'),
          String(e.andel ?? '–'),
        ])
      )
    );
  }

  // Salgshistorik
  const salg = (data.salgshistorik ?? []) as Array<Record<string, unknown>>;
  if (salg.length > 0) {
    parts.push(subheading('Handelshistorik'));
    parts.push(
      table(
        ['Dato', 'Ejer', 'Pris', 'Type'],
        salg.map((s) => [
          fmtDate(s.dato),
          String(s.ejer ?? '–'),
          fmtDkk(s.kontantPris ?? s.samletPris),
          String(s.overdragelsesmaade ?? '–'),
        ])
      )
    );
  }

  // Hæftelser
  const haeftelser = (data.haeftelser ?? []) as Array<Record<string, unknown>>;
  if (haeftelser.length > 0) {
    parts.push(subheading('Hæftelser'));
    parts.push(
      table(
        ['Dato', 'Type', 'Hovedstol', 'Restgæld', 'Kreditor'],
        haeftelser.map((h) => [
          fmtDate(h.dato),
          String(h.type ?? '–'),
          fmtDkk(h.hovedstolDkk),
          fmtDkk(h.restgaeldDkk),
          String(h.kreditor ?? '–'),
        ])
      )
    );
  }

  parts.push(...renderAi(ai));
  return parts;
}

function renderServitutter(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  const parts: string[] = [];
  const servitutter = (data.servitutter ?? []) as Array<Record<string, unknown>>;
  if (servitutter.length > 0) {
    parts.push(
      table(
        ['Dato', 'Type', 'Akt nr.', 'Beskrivelse'],
        servitutter.map((s) => [
          fmtDate(s.dato),
          String(s.type ?? '–'),
          String(s.aktNummer ?? '–'),
          typeof s.beskrivelse === 'string' && s.beskrivelse.length > 60
            ? s.beskrivelse.substring(0, 60) + '…'
            : String(s.beskrivelse ?? '–'),
        ])
      )
    );
  } else {
    parts.push(p('Ingen servitutter tinglyst.', { color: '64748b' }));
  }
  if (data.noter && typeof data.noter === 'string') {
    parts.push(subheading('Noter'));
    parts.push(p(data.noter, { color: '334155' }));
  }
  parts.push(...renderAi(ai));
  return parts;
}

function renderBeliggenhed(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  const parts = [
    field('Adresse', data.adresse),
    field('Kommune', data.kommune),
    field('Region', data.region),
    field('Zone', data.zone),
  ];
  if (data.noter && typeof data.noter === 'string') {
    parts.push(subheading('Besigtigelsesnoter'));
    parts.push(p(data.noter, { color: '334155' }));
  }
  parts.push(...renderAi(ai));
  return parts;
}

function renderRisiko(indhold: Record<string, unknown>): string[] {
  const { data, ai } = extractParts(indhold);
  const parts: string[] = [];

  // Trykprøvning
  const tp = data.trykproevning as Record<string, unknown> | null;
  if (tp) {
    parts.push(subheading('Trykprøvning af kvm-pris'));
    parts.push(field('Ejendom kvm-pris', fmtDkk(tp.ejendomKvmPris)));
    parts.push(field('Reference median', fmtDkk(tp.referenceMedianKvmPris)));
    parts.push(field('Reference gennemsnit', fmtDkk(tp.referenceGennemsnitKvmPris)));
    parts.push(field('Afvigelse', tp.afvigelseProcent != null ? `${tp.afvigelseProcent}%` : '–'));
    if (tp.flagget === true) {
      parts.push(
        p('⚠ Afvigelse > 20% — yderligere undersøgelse anbefales', { bold: true, color: 'dc2626' })
      );
    }
  }

  // Referenceejendomme
  const refs = (data.referenceejendomme ?? []) as Array<Record<string, unknown>>;
  if (refs.length > 0) {
    parts.push(subheading(`Referenceejendomme (${refs.length})`));
    parts.push(
      table(
        ['Adresse', 'Dato', 'Pris', 'Areal', 'Kvm-pris'],
        refs.map((r) => [
          typeof r.adresse === 'string' && r.adresse.length > 30
            ? r.adresse.substring(0, 30) + '…'
            : String(r.adresse ?? '–'),
          fmtDate(r.salgsdato),
          fmtDkk(r.kontantKoebesum ?? r.samletKoebesum),
          r.boligareal ? `${r.boligareal} m²` : '–',
          fmtDkk(r.kvmPris),
        ])
      )
    );
  }

  parts.push(...renderAi(ai));
  return parts;
}

/** Map of tab key → renderer. */
const TAB_RENDERERS: Record<string, (indhold: Record<string, unknown>) => string[]> = {
  identifikation: renderIdentifikation,
  bygningsdata: renderBygningsdata,
  energi: renderEnergi,
  vurdering_skat: renderVurderingSkat,
  tinglysning: renderTinglysning,
  servitutter: renderServitutter,
  beliggenhed: renderBeliggenhed,
  risiko: renderRisiko,
};

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
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

    // ── Byg DOCX ──────────────────────────────────────────────────────────
    const body: string[] = [];

    // Forside
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
    if (sag.ejendom_bfe) body.push(p(`BFE: ${sag.ejendom_bfe}`, { color: '94a3b8', size: 18 }));
    body.push(spacer());
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
        const renderer = TAB_RENDERERS[tabKey];
        if (renderer) {
          body.push(...renderer(tab.indhold));
        } else {
          body.push(p('Sektion ikke understøttet.', { color: '94a3b8' }));
        }
      } else {
        body.push(p('Ingen data tilgængelig.', { color: '94a3b8' }));
      }
      body.push(spacer());
    }

    // Disclaimer
    body.push(spacer());
    body.push(
      p(
        'Disclaimer: Denne rapport er udarbejdet automatisk af BizzAssist baseret på offentlige registre og uploadede dokumenter. Den udgør ikke en autoriseret vurdering.',
        { color: '64748b', size: 18 }
      )
    );

    // Build DOCX ZIP
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
