/**
 * Forsikrings Gap-Rapport DOCX builder — programmatisk generering.
 *
 * BIZZ-1403: Bygger professionel Word-rapport med tabeller, farver og
 * KPI-sektioner direkte fra analyse-data. Ingen AI-fritekst.
 * BIZZ-2169: Omskrevet så rapporten afspejler skærmens fulde analyse —
 * dækningsoverblik, virksomheds-bokse, SFE-arv, BBR vs police, dækket/manglende
 * pr. ejendom, refererede standardbetingelser, administrerede ejendomme og
 * portefølje-findings.
 *
 * @module lib/forsikring/rapportBuilder
 */

import { bygAnvendelseTekst } from '../bbrKoder';

/** Dækning på en police (matcher detail-API'ets coverages-shape) */
export interface RapportCoverage {
  policy_id: string;
  coverage_code: string;
  coverage_label: string;
  is_covered: boolean;
  sum_dkk: number | null;
  deductible_dkk: number | null;
  conditions_ref?: string | null;
}

/** BBR-bygningsdata pr. BFE (matcher detail-API'ets bbrByBfe-shape) */
export interface RapportBbr {
  bebygget_areal: number | null;
  antal_etager: number | null;
  opfoerelsesaar: number | null;
  anvendelse: string | null;
}

/** Aktiv-raw_data felter rapporten bruger til badges/gruppering */
interface AktivRawData {
  ejer_cvr?: string;
  ejerandel_pct?: number | string | null;
  minoritet?: boolean;
  administreret?: boolean;
  daekket_via_sfe?: { sfe_adresse?: string } | null;
  soester_sfe?: { sfe_adresse?: string } | null;
}

/** Police-shape med bygnings- og metadata-felter rapporten viser */
export interface RapportPolicy {
  id: string;
  policy_number: string;
  insurer_name: string;
  property_address: string | null;
  annual_premium_dkk: number | null;
  effective_to: string | null;
  sum_insured_dkk: number | null;
  building_use?: string | null;
  building_area_m2?: number | null;
  building_floors?: number | null;
  building_year_built?: number | null;
  building_has_basement?: boolean | null;
  insurance_form?: string | null;
  business_activity?: string | null;
}

/** Aktiv-shape (matcher detail-API'ets aktiver) */
export interface RapportAktiv {
  type: string;
  label: string;
  adresse: string | null;
  bfe?: number | null;
  cvr?: string | null;
  matched_policy_id: string | null;
  match_score: number | null;
  raw_data?: AktivRawData | null;
}

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
  aktiver: RapportAktiv[];
  policies: RapportPolicy[];
  gaps: Array<{
    policy_id: string;
    severity: string;
    title: string;
    description: string;
    recommendation: string | null;
    category?: string | null;
    check_id?: string | null;
  }>;
  /** BIZZ-2084: Dækninger per police — grøn "dækket"-liste pr. ejendom */
  coverages?: RapportCoverage[];
  /** BIZZ-2155: BBR-bygningsdata pr. BFE (nøgle = BFE som streng) */
  bbrByBfe?: Record<string, RapportBbr>;
  /** BIZZ-2135: Refererede standardbetingelser med uploaded/mangler-status */
  referencedConditions?: Array<{
    ref: string;
    selskab: string | null;
    policyNumber: string | null;
    uploaded: boolean;
  }>;
  /**
   * BIZZ-1973: Policer der dækker en adresse uden for kundens portefølje
   * (hverken ejet eller administreret). Vises som advarselssektion i rapporten.
   */
  addressMismatches?: Array<{
    policy_number: string;
    insurer_name: string;
    property_address: string | null;
    is_policyholder_address: boolean;
  }>;
  /** BIZZ-2099: Præmie-advarsler (fx manglende præmie) fra analysen */
  praemieAdvarsler?: string[];
}

// ─── Dækningskategorier (spejler ForsikringPageClient — BIZZ-2099/2127) ────
const KATEGORI_LABELS: Record<string, string> = {
  bygning: 'Bygning',
  loesoere: 'Løsøre',
  driftstab: 'Driftstab',
  ansvar: 'Ansvar',
  cyber: 'Cyber',
  kriminalitet: 'Kriminalitet',
  transport: 'Transport',
  bil: 'Bil/motor',
  andet: 'Andet',
};

const COVERAGE_KATEGORIER: Record<string, readonly string[]> = {
  bygning: [
    'brand_el',
    'bygningskasko',
    'udvidet_roerskade',
    'glas',
    'sanitet',
    'insekt_svamp',
    'restvaerdi',
    'stikledning',
    'jordskade',
    'lovliggoerelse',
    'haerverk',
    'omstilling_laase',
    'udvidet_vandskade',
  ],
  loesoere: ['loesoere', 'indbrudstyveri', 'ran_roeveri', 'oprydning', 'maskiner_itudstyr'],
  driftstab: ['driftstab', 'leverandoer_aftager', 'huslejetab'],
  ansvar: ['erhvervsansvar', 'hus_grundejer_ansvar', 'forurening'],
  cyber: ['cyber', 'cyberdriftstab', 'notifikation', 'netbank', 'it_meromkostninger'],
  kriminalitet: ['kriminalitet'],
  transport: ['transport'],
  bil: ['motorkasko', 'foererulykke', 'redning_udland', 'eftermonteret_udstyr', 'friskade'],
};

/** Opslag dækningskode → kategori */
const CODE_TO_KATEGORI: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [kat, codes] of Object.entries(COVERAGE_KATEGORIER)) {
    for (const code of codes) m.set(code, kat);
  }
  return m;
})();

/** Oversæt BBR-anvendelseskode (ofte en numerisk streng) til læsbar tekst. */
const anvendelseTekst = (raw: string | null): string | null => {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    const t = bygAnvendelseTekst(n);
    // bygAnvendelseTekst returnerer "Ukendt (kode)" / "–" hvis ukendt — vis så råværdien
    return t.startsWith('Ukendt') || t === '–' ? raw : t;
  }
  return raw;
};

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
  const addressMismatches = input.addressMismatches ?? [];

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

  // ─── SAMLET DÆKNINGSOVERBLIK (BIZZ-2169: spejler skærmens kategori-overblik) ──
  const allCoverages = input.coverages ?? [];
  const coveredCoverages = allCoverages.filter((c) => c.is_covered);
  if (coveredCoverages.length > 0) {
    // Aggregér dækninger per kategori: antal + samlet sum
    const katAgg = new Map<string, { count: number; sum: number }>();
    for (const c of coveredCoverages) {
      const kat = CODE_TO_KATEGORI.get(c.coverage_code) ?? 'andet';
      const cur = katAgg.get(kat) ?? { count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += c.sum_dkk ?? 0;
      katAgg.set(kat, cur);
    }
    body.push(heading('2. Samlet dækningsoverblik', 1));
    body.push(
      p(
        `${coveredCoverages.length} aktive dækninger på tværs af porteføljen, fordelt på ${katAgg.size} kategorier.`,
        { color: GRAY }
      )
    );
    const katRows: string[] = [
      tr(
        tc('Kategori', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 3500 }),
        tc('Antal dækninger', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2500 }),
        tc('Samlet forsikringssum', {
          bg: TABLE_HEADER_BG,
          bold: true,
          color: 'ffffff',
          width: 3000,
        })
      ),
    ];
    // Vis kategorier i fast rækkefølge (samme som COVERAGE_KATEGORIER + andet)
    const katOrder = [...Object.keys(COVERAGE_KATEGORIER), 'andet'];
    let rowIdx = 0;
    for (const kat of katOrder) {
      const agg = katAgg.get(kat);
      if (!agg) continue;
      const bg = rowIdx % 2 === 0 ? TABLE_ALT_BG : 'ffffff';
      rowIdx += 1;
      katRows.push(
        tr(
          tc(KATEGORI_LABELS[kat] ?? kat, { bg, bold: true, color: DARK, width: 3500 }),
          tc(String(agg.count), { bg, width: 2500 }),
          tc(agg.sum > 0 ? fmtDkk(agg.sum) : '—', {
            bg,
            color: agg.sum > 0 ? GREEN : GRAY,
            width: 3000,
          })
        )
      );
    }
    body.push(
      `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:bottom w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:left w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:right w:val="single" w:sz="4" w:color="${LIGHT_BLUE}"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${katRows.join('')}</w:tbl>`
    );
    body.push(spacer());
  }

  // ─── PRÆMIE-ADVARSLER (BIZZ-2099) ──────────────────────────
  const praemieAdvarsler = input.praemieAdvarsler ?? [];
  if (praemieAdvarsler.length > 0) {
    body.push(p('⚠ Præmie-advarsler', { bold: true, color: AMBER, size: 24 }));
    for (const adv of praemieAdvarsler) {
      body.push(p(`  • ${adv}`, { color: AMBER, size: 20 }));
    }
    body.push(spacer());
  }

  // ─── BIZZ-1973: ADVARSEL — policer uden for porteføljen ──────
  if (addressMismatches.length > 0) {
    body.push(
      p(`⚠ ${addressMismatches.length} police(r) dækker en adresse uden for porteføljen`, {
        bold: true,
        color: RED,
        size: 24,
      })
    );
    body.push(
      p(
        'Følgende policer dækker en ejendom der hverken ejes eller administreres af ' +
          'forsikringssejeren. Verificér at dokumentet hører til denne kunde.',
        { color: GRAY, size: 18 }
      )
    );
    body.push(
      `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="${AMBER}"/><w:bottom w:val="single" w:sz="4" w:color="${AMBER}"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>` +
        tr(
          tc('Adresse', { bg: LIGHT_AMBER_BG, bold: true, color: DARK, width: 4000 }),
          tc('Selskab', { bg: LIGHT_AMBER_BG, bold: true, color: DARK, width: 2500 }),
          tc('Police', { bg: LIGHT_AMBER_BG, bold: true, color: DARK, width: 2500 })
        ) +
        addressMismatches
          .map((m) =>
            tr(
              tc(
                (m.property_address ?? 'Ukendt adresse') +
                  (m.is_policyholder_address ? ' (forsikringstagers egen adresse)' : ''),
                { width: 4000 }
              ),
              tc(m.insurer_name, { color: GRAY, width: 2500 }),
              tc(m.policy_number, { color: GRAY, width: 2500 })
            )
          )
          .join('') +
        '</w:tbl>'
    );
    body.push(spacer());
  }

  // ─── EJENDOMSOVERSIGT (BIZZ-1802/1806: hierarkisk layout) ──
  body.push(heading('3. Ejendomsoversigt', 1));
  body.push(
    p(
      `${total} ejendomme analyseret. ${insured} forsikrede (grøn), ${total - insured} uforsikrede (rød).`,
      { color: GRAY }
    )
  );
  body.push(spacer());

  // Gruppér ejendomme under virksomheder (matching on-screen UI)
  const virkAktiver = aktiver.filter((a) => a.type === 'virksomhed');
  const ejdAktiver = aktiver.filter((a) => a.type !== 'virksomhed');
  const ejdByOwnerCvr = new Map<string, typeof ejdAktiver>();
  const orphanEjd: typeof ejdAktiver = [];
  for (const e of ejdAktiver) {
    const ownerCvr = (e as unknown as { raw_data?: { ejer_cvr?: string } }).raw_data?.ejer_cvr;
    if (
      ownerCvr &&
      virkAktiver.some(
        (v) => v.label.includes(ownerCvr) || (v as unknown as { cvr?: string }).cvr === ownerCvr
      )
    ) {
      const list = ejdByOwnerCvr.get(ownerCvr) ?? [];
      list.push(e);
      ejdByOwnerCvr.set(ownerCvr, list);
    } else {
      orphanEjd.push(e);
    }
  }

  // Sortér ejendomme: uforsikrede først, flest gaps først
  const sortEjd = (list: typeof ejdAktiver) =>
    [...list].sort((a, b) => {
      const aI = a.matched_policy_id ? 1 : 0;
      const bI = b.matched_policy_id ? 1 : 0;
      if (aI !== bI) return aI - bI;
      const aGaps = gaps.filter((g) => g.policy_id === a.matched_policy_id).length;
      const bGaps = gaps.filter((g) => g.policy_id === b.matched_policy_id).length;
      return bGaps - aGaps;
    });

  // Render virksomheder med ejendomme hierarkisk
  for (const virk of virkAktiver) {
    const virkCvr = (virk as unknown as { cvr?: string }).cvr ?? '';
    const virkEjd = sortEjd(ejdByOwnerCvr.get(virkCvr) ?? []);
    const virkInsured = virkEjd.filter((e) => !!e.matched_policy_id).length;
    const virkGaps = virkEjd.reduce(
      (sum, e) => sum + gaps.filter((g) => g.policy_id === e.matched_policy_id).length,
      0
    );

    // Virksomheds-header med KPI'er
    body.push(p(`▼ ${virk.label}`, { bold: true, color: DARK, size: 26 }));
    // CVR + ejerandel/minoritet badges (spejler skærmens virksomheds-boks)
    const virkRaw = virk.raw_data ?? {};
    const virkMeta: string[] = [];
    if (virk.cvr) virkMeta.push(`CVR ${virk.cvr}`);
    const ejerandel = virkRaw.ejerandel_pct;
    if (ejerandel !== null && ejerandel !== undefined && ejerandel !== '') {
      virkMeta.push(`Ejerandel ${ejerandel}%`);
    }
    if (virkRaw.minoritet) virkMeta.push('Minoritetspost');
    if (virkMeta.length > 0) {
      body.push(p(`  ${virkMeta.join(' · ')}`, { color: GRAY, size: 18 }));
    }
    body.push(
      p(`  ${virkEjd.length} ejendomme · ${virkInsured} forsikrede · ${virkGaps} gaps`, {
        color: GRAY,
        size: 18,
      })
    );

    // Ejendoms-tabel under virksomheden
    if (virkEjd.length > 0) {
      const rows: string[] = [
        tr(
          tc('Status', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1200 }),
          tc('Adresse', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 4000 }),
          tc('Police', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1800 }),
          tc('Gaps', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1000 })
        ),
      ];
      for (const e of virkEjd) {
        const isIns = !!e.matched_policy_id;
        const pol = e.matched_policy_id ? policyById.get(e.matched_policy_id) : null;
        const eGaps = gaps.filter((g) => g.policy_id === e.matched_policy_id).length;
        const bg = isIns ? LIGHT_GREEN_BG : LIGHT_RED_BG;
        rows.push(
          tr(
            tc(isIns ? '✓' : '✗', { bg, bold: true, color: isIns ? GREEN : RED, width: 1200 }),
            tc(e.adresse || e.label || '—', { bg, width: 4000 }),
            tc(pol?.policy_number ?? '—', { bg, width: 1800 }),
            tc(eGaps > 0 ? String(eGaps) : '—', { bg, color: eGaps > 0 ? RED : GRAY, width: 1000 })
          )
        );
      }
      body.push(
        `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/><w:tblInd w:w="500" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="2" w:color="e2e8f0"/><w:bottom w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideH w:val="single" w:sz="1" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`
      );
    }
    body.push(spacer());
  }

  // Orphan-ejendomme (uden virksomheds-ejer)
  if (orphanEjd.length > 0) {
    body.push(p('Øvrige ejendomme', { bold: true, color: DARK, size: 24 }));
    const rows: string[] = [
      tr(
        tc('Status', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1200 }),
        tc('Adresse', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 4800 }),
        tc('Police', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2000 })
      ),
    ];
    for (const e of sortEjd(orphanEjd)) {
      const isIns = !!e.matched_policy_id;
      const pol = e.matched_policy_id ? policyById.get(e.matched_policy_id) : null;
      const bg = isIns ? LIGHT_GREEN_BG : LIGHT_RED_BG;
      rows.push(
        tr(
          tc(isIns ? '✓ Forsikret' : '✗ Uforsikret', {
            bg,
            bold: true,
            color: isIns ? GREEN : RED,
            width: 1200,
          }),
          tc(e.adresse || e.label || '—', { bg, width: 4800 }),
          tc(pol?.policy_number ?? '—', { bg, width: 2000 })
        )
      );
    }
    body.push(
      `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="2" w:color="e2e8f0"/><w:bottom w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideH w:val="single" w:sz="1" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`
    );
    body.push(spacer());
  }

  // Sorteret aktiver til brug i gap-sektioner
  const sortedAktiver = sortEjd(ejdAktiver);

  // ─── UFORSIKREDE EJENDOMME (detaljer) ─────────────────────
  const uforsikrede = sortedAktiver.filter((a) => !a.matched_policy_id);
  if (uforsikrede.length > 0) {
    body.push(heading('3a. Uforsikrede ejendomme', 2));
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
    body.push(heading('3b. Forsikrede ejendomme med gaps', 2));
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

      // SFE-arv / søster-SFE badges (BIZZ-2169: spejler skærmens badges)
      const aRaw = a.raw_data ?? {};
      if (aRaw.daekket_via_sfe?.sfe_adresse) {
        body.push(
          p(`  ⓘ Dækket via SFE: ${aRaw.daekket_via_sfe.sfe_adresse}`, {
            color: LIGHT_BLUE,
            size: 18,
          })
        );
      }
      if (aRaw.soester_sfe?.sfe_adresse) {
        body.push(
          p(`  ⓘ Søster-SFE: ${aRaw.soester_sfe.sfe_adresse}`, { color: LIGHT_BLUE, size: 18 })
        );
      }

      // BIZZ-2155: BBR-bygningsdata vs police-bygningsdata
      const bbr = a.bfe != null ? input.bbrByBfe?.[String(a.bfe)] : undefined;
      const hasPoliceBuilding =
        policy &&
        (policy.building_use != null ||
          policy.building_area_m2 != null ||
          policy.building_floors != null ||
          policy.building_year_built != null);
      if (bbr || hasPoliceBuilding) {
        const bbrAnv = anvendelseTekst(bbr?.anvendelse ?? null);
        const polAnv = anvendelseTekst(policy?.building_use ?? null);
        const buildRows: string[] = [
          tr(
            tc('Bygningsdata', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 3000 }),
            tc('BBR-register', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2500 }),
            tc('Police', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2500 })
          ),
          tr(
            tc('Anvendelse', { width: 3000 }),
            tc(bbrAnv ?? '—', { color: GRAY, width: 2500 }),
            tc(polAnv ?? '—', { color: GRAY, width: 2500 })
          ),
          tr(
            tc('Bebygget areal', { width: 3000 }),
            tc(bbr?.bebygget_areal != null ? `${bbr.bebygget_areal} m²` : '—', {
              color: GRAY,
              width: 2500,
            }),
            tc(policy?.building_area_m2 != null ? `${policy.building_area_m2} m²` : '—', {
              color: GRAY,
              width: 2500,
            })
          ),
          tr(
            tc('Antal etager', { width: 3000 }),
            tc(bbr?.antal_etager != null ? String(bbr.antal_etager) : '—', {
              color: GRAY,
              width: 2500,
            }),
            tc(policy?.building_floors != null ? String(policy.building_floors) : '—', {
              color: GRAY,
              width: 2500,
            })
          ),
          tr(
            tc('Opførelsesår', { width: 3000 }),
            tc(bbr?.opfoerelsesaar != null ? String(bbr.opfoerelsesaar) : '—', {
              color: GRAY,
              width: 2500,
            }),
            tc(policy?.building_year_built != null ? String(policy.building_year_built) : '—', {
              color: GRAY,
              width: 2500,
            })
          ),
        ];
        body.push(
          `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="2" w:color="e2e8f0"/><w:bottom w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideH w:val="single" w:sz="1" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="1" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${buildRows.join('')}</w:tbl>`
        );
        body.push(spacer());
      }

      // BIZZ-1633: Vis eksisterende dækninger (grøn) FØR gaps (rød/gul)
      const ejendomCoverages = (input.coverages ?? []).filter(
        (c) => c.policy_id === a.matched_policy_id && c.is_covered
      );
      if (ejendomCoverages.length > 0) {
        const covRows: string[] = [
          tr(
            tc('Dækning', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 3500 }),
            tc('Forsikringssum', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2500 }),
            tc('Selvrisiko', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2000 })
          ),
        ];
        for (const cov of ejendomCoverages) {
          covRows.push(
            tr(
              tc(`✓ ${cov.coverage_label}`, {
                bg: LIGHT_GREEN_BG,
                bold: true,
                color: GREEN,
                width: 3500,
              }),
              tc(fmtDkk(cov.sum_dkk), { bg: LIGHT_GREEN_BG, width: 2500 }),
              tc(fmtDkk(cov.deductible_dkk), { bg: LIGHT_GREEN_BG, color: GRAY, width: 2000 })
            )
          );
        }
        body.push(
          `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="2" w:color="${GREEN}"/><w:bottom w:val="single" w:sz="2" w:color="e2e8f0"/><w:left w:val="single" w:sz="6" w:color="${GREEN}"/><w:insideH w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="2" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${covRows.join('')}</w:tbl>`
        );
        body.push(spacer());
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

  // ─── REFEREREDE STANDARDBETINGELSER (BIZZ-2135) ────────────
  const referencedConditions = input.referencedConditions ?? [];
  if (referencedConditions.length > 0) {
    body.push(heading('4. Refererede standardbetingelser', 1));
    body.push(
      p(
        `${referencedConditions.length} betingelses-referencer fundet i policerne. ` +
          'Grøn = dokumentet er uploadet og kan vurderes, rød = mangler.',
        { color: GRAY }
      )
    );
    const condRows: string[] = [
      tr(
        tc('Reference', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 3500 }),
        tc('Selskab', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 2500 }),
        tc('Police', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1500 }),
        tc('Status', { bg: TABLE_HEADER_BG, bold: true, color: 'ffffff', width: 1500 })
      ),
    ];
    for (const rc of referencedConditions) {
      const bg = rc.uploaded ? LIGHT_GREEN_BG : LIGHT_RED_BG;
      condRows.push(
        tr(
          tc(rc.ref, { bg, bold: true, width: 3500 }),
          tc(rc.selskab ?? '—', { bg, color: GRAY, width: 2500 }),
          tc(rc.policyNumber ?? '—', { bg, color: GRAY, width: 1500 }),
          tc(rc.uploaded ? '✓ Uploadet' : '✗ Mangler', {
            bg,
            bold: true,
            color: rc.uploaded ? GREEN : RED,
            width: 1500,
          })
        )
      );
    }
    body.push(
      `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="2" w:color="e2e8f0"/><w:bottom w:val="single" w:sz="2" w:color="e2e8f0"/><w:insideH w:val="single" w:sz="1" w:color="e2e8f0"/><w:insideV w:val="single" w:sz="1" w:color="e2e8f0"/></w:tblBorders></w:tblPr>${condRows.join('')}</w:tbl>`
    );
    body.push(spacer());
  }

  // ─── POLICE-OVERSIGT ───────────────────────────────────────
  body.push(heading('5. Police-oversigt', 1));

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
    body.push(heading('6. Forsikringsgaps', 1));
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
