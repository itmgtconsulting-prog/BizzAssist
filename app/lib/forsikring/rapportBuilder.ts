/**
 * Forsikrings Gap-Rapport DOCX builder — programmatisk generering.
 *
 * BIZZ-1403: Bygger professionel Word-rapport med tabeller, farver og
 * KPI-sektioner direkte fra analyse-data. Ingen AI-fritekst.
 *
 * @module lib/forsikring/rapportBuilder
 */

/** Input til rapport-generering */
export interface GapRapportInput {
  kundeNavn: string;
  analyse: {
    total_aktiver: number;
    insured_count: number;
    uninsured_count: number;
    total_risk_score: number;
    created_at: string;
  };
  aktiver: Array<{
    type: string;
    label: string;
    adresse: string | null;
    matched_policy_id: string | null;
    match_score: number | null;
  }>;
  policies: Array<{
    id: string;
    policy_number: string;
    insurer_name: string;
    property_address: string | null;
    annual_premium_dkk: number | null;
    effective_to: string | null;
    sum_insured_dkk: number | null;
  }>;
  gaps: Array<{
    policy_id: string;
    severity: string;
    title: string;
    description: string;
    recommendation: string | null;
  }>;
}

/** XML-escape */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Format DKK */
const fmtDkk = (n: number | null) => (n !== null ? `${n.toLocaleString('da-DK')} kr` : '—');

/** Format dato */
const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
};

// ─── Farver ────────────────────────────────────────────────
const BLUE = '1e40af';
const LIGHT_BLUE = '3b82f6';
const DARK = '1e293b';
const GREEN = '059669';
const RED = 'dc2626';
const AMBER = 'd97706';
const GRAY = '64748b';
const LIGHT_GREEN_BG = 'ecfdf5';
const LIGHT_RED_BG = 'fef2f2';
const LIGHT_AMBER_BG = 'fffbeb';
const LIGHT_BLUE_BG = 'eff6ff';
const TABLE_HEADER_BG = '1e293b';
const TABLE_ALT_BG = 'f8fafc';

// ─── OOXML helpers ─────────────────────────────────────────

/** Simpel paragraph */
const p = (
  text: string,
  opts?: { bold?: boolean; color?: string; size?: number; align?: string }
) => {
  const rpr: string[] = [];
  if (opts?.bold) rpr.push('<w:b/><w:bCs/>');
  if (opts?.color) rpr.push(`<w:color w:val="${opts.color}"/>`);
  if (opts?.size) rpr.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  const ppr: string[] = [];
  if (opts?.align) ppr.push(`<w:jc w:val="${opts.align}"/>`);
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : ''}<w:r>${rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
};

/** Heading */
const heading = (text: string, level: 1 | 2) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

/** Tabel-celle */
const tc = (
  text: string,
  opts?: { bg?: string; bold?: boolean; color?: string; width?: number }
) => {
  const tcPr: string[] = [];
  if (opts?.bg) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.bg}"/>`);
  if (opts?.width) tcPr.push(`<w:tcW w:w="${opts.width}" w:type="dxa"/>`);
  tcPr.push(
    '<w:tcMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar>'
  );
  const rpr: string[] = [];
  if (opts?.bold) rpr.push('<w:b/><w:bCs/>');
  if (opts?.color) rpr.push(`<w:color w:val="${opts.color}"/>`);
  return `<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r>${rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
};

/** Tabel-række */
const tr = (...cells: string[]) => `<w:tr>${cells.join('')}</w:tr>`;

/** Tom linje (spacer) */
const spacer = () => '<w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>';

/** Horisontal linje */
const hline = (color = LIGHT_BLUE) =>
  `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${color}"/></w:pBdr><w:spacing w:after="200"/></w:pPr></w:p>`;

/**
 * Byg DOCX-buffer for forsikrings gap-rapport.
 *
 * @param input - Strukturerede data fra analyse
 * @returns Buffer med DOCX
 */
export async function buildGapRapportDocx(input: GapRapportInput): Promise<Buffer> {
  const { default: PizZip } = await import('pizzip');
  const { kundeNavn, analyse, aktiver, policies, gaps } = input;

  const policyById = new Map(policies.map((p) => [p.id, p]));
  const total = analyse.total_aktiver;
  const insured = analyse.insured_count;
  const pct = total > 0 ? Math.round((insured / total) * 100) : 0;
  const critGaps = gaps.filter((g) => g.severity === 'critical').length;
  const warnGaps = gaps.filter((g) => g.severity === 'warning').length;
  const infoGaps = gaps.filter((g) => g.severity === 'info').length;
  const gapPenalty = Math.min(30, critGaps * 5 + Math.min(gaps.length, 20));
  const healthScore = Math.max(0, Math.min(100, pct - gapPenalty));
  const scoreColor = healthScore >= 71 ? GREEN : healthScore >= 41 ? AMBER : RED;
  const dato = fmtDate(analyse.created_at);
  const totalPremie = policies.reduce((sum, p) => sum + (p.annual_premium_dkk ?? 0), 0);

  const body: string[] = [];

  // ─── FORSIDE ───────────────────────────────────────────────
  body.push(p('FORSIKRINGS GAP-RAPPORT', { bold: true, color: BLUE, size: 48, align: 'center' }));
  body.push(spacer());
  body.push(p(kundeNavn, { bold: true, color: DARK, size: 36, align: 'center' }));
  body.push(p(`Analyse dato: ${dato}`, { color: GRAY, size: 22, align: 'center' }));
  body.push(p('Udarbejdet af BizzAssist', { color: GRAY, size: 20, align: 'center' }));
  body.push(spacer());
  body.push(hline());

  // ─── SUNDHEDSSCORE ─────────────────────────────────────────
  body.push(heading('1. Sundhedsscore', 1));
  body.push(
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:bottom w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>` +
      tr(
        tc('Sundhedsscore', { bg: LIGHT_BLUE_BG, bold: true, color: DARK, width: 3000 }),
        tc(`${healthScore} / 100`, {
          bg: LIGHT_BLUE_BG,
          bold: true,
          color: scoreColor,
          width: 2000,
        }),
        tc(healthScore >= 71 ? 'God' : healthScore >= 41 ? 'Middel' : 'Kritisk', {
          bg: LIGHT_BLUE_BG,
          bold: true,
          color: scoreColor,
          width: 2000,
        })
      ) +
      tr(
        tc('Dækningsgrad', { width: 3000 }),
        tc(`${pct}%`, { bold: true, width: 2000 }),
        tc(`${insured} af ${total} ejendomme forsikret`, { color: GRAY, width: 2000 })
      ) +
      tr(
        tc('Samlet årlig præmie', { width: 3000 }),
        tc(fmtDkk(totalPremie > 0 ? totalPremie : null), { bold: true, width: 2000 }),
        tc(`${policies.length} policer`, { color: GRAY, width: 2000 })
      ) +
      tr(
        tc('Detekterede gaps', { width: 3000 }),
        tc(`${gaps.length}`, { bold: true, color: gaps.length > 0 ? RED : GREEN, width: 2000 }),
        tc(`${critGaps} kritiske, ${warnGaps} advarsler, ${infoGaps} info`, {
          color: GRAY,
          width: 2000,
        })
      ) +
      '</w:tbl>'
  );
  body.push(spacer());

  // ─── EJENDOMSOVERSIGT ──────────────────────────────────────
  body.push(heading('2. Ejendomsoversigt', 1));
  body.push(
    p(
      `${total} ejendomme analyseret. ${insured} forsikrede (grøn), ${total - insured} uforsikrede (rød).`,
      { color: GRAY }
    )
  );
  body.push(spacer());

  // Tabel header
  const ejendomRows: string[] = [
    tr(
      tc('Status', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1200 }),
      tc('Adresse', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 4000 }),
      tc('Police', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1800 }),
      tc('Selskab', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2000 })
    ),
  ];

  // Sortér: uforsikrede først
  const sortedAktiver = [...aktiver].sort((a, b) => {
    const aI = a.matched_policy_id ? 1 : 0;
    const bI = b.matched_policy_id ? 1 : 0;
    return aI - bI;
  });

  for (let i = 0; i < sortedAktiver.length; i++) {
    const a = sortedAktiver[i];
    const isInsured = !!a.matched_policy_id;
    const policy = a.matched_policy_id ? policyById.get(a.matched_policy_id) : null;
    const rowBg = isInsured ? (i % 2 === 0 ? LIGHT_GREEN_BG : 'ffffff') : LIGHT_RED_BG;
    const statusText = isInsured ? '✓ Forsikret' : '✗ Uforsikret';
    const statusColor = isInsured ? GREEN : RED;

    ejendomRows.push(
      tr(
        tc(statusText, { bg: rowBg, bold: true, color: statusColor, width: 1200 }),
        tc(a.adresse || a.label || '—', { bg: rowBg, width: 4000 }),
        tc(policy?.policy_number ?? '—', { bg: rowBg, width: 1800 }),
        tc(policy?.insurer_name ?? '—', { bg: rowBg, color: GRAY, width: 2000 })
      )
    );
  }

  body.push(
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:bottom w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:left w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:right w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${ejendomRows.join('')}</w:tbl>`
  );
  body.push(spacer());

  // ─── UFORSIKREDE EJENDOMME (detaljer) ─────────────────────
  const uforsikrede = sortedAktiver.filter((a) => !a.matched_policy_id);
  if (uforsikrede.length > 0) {
    body.push(heading('2a. Uforsikrede ejendomme', 2));
    body.push(
      p(`${uforsikrede.length} ejendomme uden forsikringsdækning:`, { color: RED, bold: true })
    );
    for (const a of uforsikrede) {
      body.push(p(`  ✗  ${a.adresse || a.label || '—'}`, { color: RED }));
    }
    body.push(
      p('Anbefaling: Kontakt forsikringsselskab for at tegne dækning på ovenstående ejendomme.', {
        color: GRAY,
        size: 20,
      })
    );
    body.push(spacer());
  }

  // ─── FORSIKREDE EJENDOMME MED GAPS (detaljer per ejendom) ─
  const forsikrede = sortedAktiver.filter((a) => !!a.matched_policy_id);
  const forsikredeMedGaps = forsikrede.filter((a) => {
    return gaps.some((g) => g.policy_id === a.matched_policy_id);
  });
  if (forsikredeMedGaps.length > 0) {
    body.push(heading('2b. Forsikrede ejendomme med gaps', 2));
    body.push(
      p(`${forsikredeMedGaps.length} forsikrede ejendomme har dækningsmangler:`, { color: AMBER })
    );
    body.push(spacer());

    for (const a of forsikredeMedGaps) {
      const policy = a.matched_policy_id ? policyById.get(a.matched_policy_id) : null;
      body.push(p(`${a.adresse || a.label}`, { bold: true, color: DARK, size: 24 }));
      if (policy) {
        body.push(
          p(
            `Police: ${policy.policy_number} — ${policy.insurer_name} — Præmie: ${fmtDkk(policy.annual_premium_dkk)} — Udløber: ${fmtDate(policy.effective_to)}`,
            { color: GRAY, size: 20 }
          )
        );
      }

      const ejendomGaps = gaps.filter((g) => g.policy_id === a.matched_policy_id);
      if (ejendomGaps.length > 0) {
        const gapDetailRows: string[] = [
          tr(
            tc('Alvor', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1200 }),
            tc('Gap', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2800 }),
            tc('Beskrivelse', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 3000 }),
            tc('Anbefaling', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2000 })
          ),
        ];
        for (const g of ejendomGaps) {
          const sevColor =
            g.severity === 'critical' ? RED : g.severity === 'warning' ? AMBER : LIGHT_BLUE;
          const sevBg =
            g.severity === 'critical'
              ? LIGHT_RED_BG
              : g.severity === 'warning'
                ? LIGHT_AMBER_BG
                : LIGHT_BLUE_BG;
          const sevLabel =
            g.severity === 'critical'
              ? '● Kritisk'
              : g.severity === 'warning'
                ? '● Advarsel'
                : '● Info';
          gapDetailRows.push(
            tr(
              tc(sevLabel, { bg: sevBg, bold: true, color: sevColor, width: 1200 }),
              tc(g.title, { bg: sevBg, bold: true, width: 2800 }),
              tc(g.description.slice(0, 200), { width: 3000 }),
              tc(g.recommendation?.slice(0, 120) ?? '—', { color: GRAY, width: 2000 })
            )
          );
        }
        body.push(
          `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="2" w:color="e2e8f0"/><w:bottom w:val="single" w:sz="2" w:color="e2e8f0"/><w:left w:val="single" w:sz="2" w:color="e2e8f0"/><w:right w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${gapDetailRows.join('')}</w:tbl>`
        );
      }
      body.push(spacer());
    }
  }

  // ─── POLICE-OVERSIGT ───────────────────────────────────────
  body.push(heading('3. Police-oversigt', 1));

  const policeRows: string[] = [
    tr(
      tc('Police nr.', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1500 }),
      tc('Selskab', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2000 }),
      tc('Adresse', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2500 }),
      tc('Præmie', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1500 }),
      tc('Udløber', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1500 })
    ),
  ];

  for (let i = 0; i < policies.length; i++) {
    const pol = policies[i];
    const bg = i % 2 === 0 ? TABLE_ALT_BG : 'ffffff';
    policeRows.push(
      tr(
        tc(pol.policy_number, { bg, bold: true, color: BLUE, width: 1500 }),
        tc(pol.insurer_name, { bg, width: 2000 }),
        tc(pol.property_address ?? '—', { bg, width: 2500 }),
        tc(fmtDkk(pol.annual_premium_dkk), { bg, width: 1500 }),
        tc(fmtDate(pol.effective_to), { bg, width: 1500 })
      )
    );
  }

  body.push(
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:bottom w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:left w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:right w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${policeRows.join('')}</w:tbl>`
  );
  body.push(spacer());

  // ─── GAP-ANALYSE ───────────────────────────────────────────
  if (gaps.length > 0) {
    body.push(heading('4. Forsikringsgaps', 1));
    body.push(
      p(`${gaps.length} gaps identificeret på tværs af ${policies.length} policer.`, {
        color: GRAY,
      })
    );
    body.push(spacer());

    const gapRows: string[] = [
      tr(
        tc('Alvor', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1200 }),
        tc('Gap', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 3000 }),
        tc('Beskrivelse', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 3000 }),
        tc('Anbefaling', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1800 })
      ),
    ];

    for (const g of gaps) {
      const sevColor =
        g.severity === 'critical' ? RED : g.severity === 'warning' ? AMBER : LIGHT_BLUE;
      const sevBg =
        g.severity === 'critical'
          ? LIGHT_RED_BG
          : g.severity === 'warning'
            ? LIGHT_AMBER_BG
            : LIGHT_BLUE_BG;
      const sevLabel =
        g.severity === 'critical'
          ? '● Kritisk'
          : g.severity === 'warning'
            ? '● Advarsel'
            : '● Info';

      gapRows.push(
        tr(
          tc(sevLabel, { bg: sevBg, bold: true, color: sevColor, width: 1200 }),
          tc(g.title, { bg: sevBg, bold: true, width: 3000 }),
          tc(g.description.slice(0, 150), { width: 3000 }),
          tc(g.recommendation?.slice(0, 100) ?? '—', { color: GRAY, width: 1800 })
        )
      );
    }

    body.push(
      `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:bottom w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:left w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:right w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${gapRows.join('')}</w:tbl>`
    );
    body.push(spacer());
  }

  // ─── DISCLAIMER ────────────────────────────────────────────
  body.push(hline(GRAY));
  body.push(
    p(
      'Disclaimer: Denne rapport er udarbejdet på baggrund af uploadede forsikringsdokumenter og registerdata fra BizzAssist. Den udgør ikke juridisk eller forsikringsmæssig rådgivning. Endelig rådgivning bør ske ved en autoriseret forsikringsmægler.',
      { color: GRAY, size: 18 }
    )
  );

  // ─── Byg DOCX ─────────────────────────────────────────────
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
      <w:sz w:val="22"/><w:szCs w:val="22"/>
      <w:color w:val="${DARK}"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr>
      <w:spacing w:after="80" w:line="276" w:lineRule="auto"/>
    </w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:spacing w:before="300" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${BLUE}"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:bCs/><w:color w:val="${DARK}"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
</w:styles>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567"/>
    </w:sectPr>
  </w:body>
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
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const zip = new PizZip();
  zip.file('[Content_Types].xml', contentTypesXml);
  zip.file('_rels/.rels', relsXml);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/_rels/document.xml.rels', wordRelsXml);

  return Buffer.from(zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
