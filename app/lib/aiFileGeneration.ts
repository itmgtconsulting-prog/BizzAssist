/**
 * BIZZ-811 (AI DocGen 2/8): Server-side file generators til AI tool-use
 * pipeline. Producerer Buffer-output klar til upload i
 * ai-generated-bucket (BIZZ-810).
 *
 * Design:
 *   * Rene pure-functions — ingen network/DB-kald — så de kan unit-testes
 *     isoleret med fixture data.
 *   * Zod-validering på alle inputs → tool-dispatcher kan reject malformet
 *     AI-output før generator kaldes.
 *   * Hard limits: max 50 cols, 10k rows, 500 char/cell, 5MB output.
 *   * Security: formula-injection-escape på XLSX/CSV (OWASP) og filename-
 *     sanitize (no `/\..` / control-chars, max 100 chars).
 *
 * Exports:
 *   generateXlsx() - exceljs-baseret spreadsheet
 *   generateCsv()  - UTF-8 BOM + semicolon/custom delimiter for Excel-DK
 *   generateDocx() - minimalt DOCX fra PizZip + inline XML (ingen template)
 *   fillDocxTemplate() - docxtemplater placeholder-fill (reuse af
 *     eksisterende logik fra generate/route.ts — BIZZ-744 pattern)
 *   fillXlsxTemplate() - iter-2 stub, kaster hvis kaldt
 *   sanitizeFilename() - OWASP-safe filename
 */

import { z } from 'zod';

// ─── Constants / limits ────────────────────────────────────────────────

/** Max output-størrelse i bytes (5MB). Beskytter mod overlarge AI-output. */
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
/** Max antal kolonner i XLSX/CSV. */
export const MAX_COLUMNS = 50;
/** Max antal rækker i XLSX/CSV. */
export const MAX_ROWS = 10_000;
/** Max antal tegn pr celle (efter stringification). */
export const MAX_CELL_CHARS = 500;
/** Max antal tegn i filename. */
export const MAX_FILENAME_CHARS = 100;

// ─── Typer ──────────────────────────────────────────────────────────────

export type GeneratedFile = {
  buffer: Buffer;
  ext: 'xlsx' | 'csv' | 'docx' | 'pptx';
  contentType: string;
};

export type XlsxCellValue = string | number | boolean | Date | null | undefined;

// ─── Zod-schemas for tool-dispatcher validering ────────────────────────

const XlsxColumnSchema = z.object({
  key: z.string().min(1).max(100),
  header: z.string().min(1).max(200),
  width: z.number().positive().optional(),
});

export const GenerateXlsxInputSchema = z.object({
  title: z.string().min(1).max(200),
  columns: z.array(XlsxColumnSchema).min(1).max(MAX_COLUMNS),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .max(MAX_ROWS),
  sheetName: z.string().min(1).max(31).optional(), // Excel: 31 char sheet-name limit
});

export const GenerateCsvInputSchema = z.object({
  columns: z.array(XlsxColumnSchema).min(1).max(MAX_COLUMNS),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .max(MAX_ROWS),
  delimiter: z.string().length(1).default(';'),
});

export const GenerateDocxInputSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).optional(),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(200),
        body: z.string().max(50_000),
        /** BIZZ-934: Valgfri base64-encoded PNG til indlejring i DOCX. */
        imageBase64: z.string().max(5_000_000).optional(),
      })
    )
    .min(1)
    .max(100),
});

// BIZZ-935: PPTX schema — slides med titel + bullet-punkter
export const GeneratePptxInputSchema = z.object({
  title: z.string().min(1).max(200),
  slides: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        bullets: z.array(z.string().max(2000)).max(20).optional(),
        table: z
          .object({
            columns: z.array(z.string().max(100)).min(1).max(10),
            rows: z.array(z.array(z.string().max(500))).max(50),
          })
          .optional(),
      })
    )
    .min(1)
    .max(50),
});

export type GenerateXlsxInput = z.infer<typeof GenerateXlsxInputSchema>;
export type GenerateCsvInput = z.infer<typeof GenerateCsvInputSchema>;
export type GenerateDocxInput = z.infer<typeof GenerateDocxInputSchema>;
export type GeneratePptxInput = z.infer<typeof GeneratePptxInputSchema>;

// ─── Helpers: security + sanitation ─────────────────────────────────────

/**
 * OWASP-safe filename: strip path-separators, parent-dir-traversal,
 * kontroltegn; limit til MAX_FILENAME_CHARS. Returnerer 'file' hvis
 * input blev tomt efter strip.
 */
export function sanitizeFilename(raw: string): string {
  const noPath = raw.replace(/[\\/]/g, '_');
  const noDots = noPath.replace(/\.\.+/g, '_');
  const noCtrl = noDots.replace(/[\x00-\x1f\x7f]/g, '');
  const trimmed = noCtrl.trim().slice(0, MAX_FILENAME_CHARS);
  return trimmed.length > 0 ? trimmed : 'file';
}

/**
 * OWASP XLSX/CSV formula-injection-escape. Celler der starter med
 * `=`, `+`, `-`, `@` kan interpreteres som formula i Excel og eksfiltere
 * data. Prefix med apostrof så Excel viser dem som tekst.
 */
export function escapeFormula(value: string): string {
  if (value.length === 0) return value;
  const first = value[0];
  if (first === '=' || first === '+' || first === '-' || first === '@') {
    return `'${value}`;
  }
  return value;
}

/** Coerce unknown til XLSX-acceptable celle-værdi. undefined → '' */
function coerceCellValue(v: XlsxCellValue): string | number | boolean | Date {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  // Stringify + truncate + formula-escape
  const s = String(v).slice(0, MAX_CELL_CHARS);
  return escapeFormula(s);
}

// ─── Generator: XLSX ────────────────────────────────────────────────────

/**
 * Produceret XLSX-fil via exceljs. Kolonner defineres via key+header+width.
 * Rows er Record<string, value> hvor key matcher column.key.
 *
 * Auto-filter + sticky-header + formula-escape.
 *
 * @param input - Valideret GenerateXlsxInput
 */
export async function generateXlsx(input: GenerateXlsxInput): Promise<GeneratedFile> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BizzAssist AI';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(input.sheetName ?? 'Ark1');

  // Header row
  sheet.columns = input.columns.map((c) => ({
    key: c.key,
    header: c.header,
    width: c.width ?? Math.min(Math.max(c.header.length + 2, 10), 50),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Data rows
  for (const row of input.rows) {
    const coerced: Record<string, string | number | boolean | Date> = {};
    for (const col of input.columns) {
      coerced[col.key] = coerceCellValue(row[col.key] as XlsxCellValue);
    }
    sheet.addRow(coerced);
  }

  // Auto-filter over header-range
  if (input.rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: input.columns.length },
    };
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new Error(`XLSX output ${buffer.length}B overstiger ${MAX_OUTPUT_BYTES}B limit`);
  }
  return {
    buffer,
    ext: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

// ─── Generator: CSV ─────────────────────────────────────────────────────

/**
 * UTF-8 BOM prefix så Excel-DK åbner med korrekte æøå. Semicolon-delimiter
 * default (Excel-DK standard). Escape regel: celle der indeholder delimiter,
 * CR/LF eller " wrappes i " og " selv dobles.
 */
export function generateCsv(input: GenerateCsvInput): GeneratedFile {
  const { columns, rows, delimiter = ';' } = input;

  const escapeCell = (raw: unknown): string => {
    if (raw === null || raw === undefined) return '';
    let s: string;
    if (raw instanceof Date) s = raw.toISOString().slice(0, 10);
    else s = String(raw).slice(0, MAX_CELL_CHARS);
    // OWASP formula-injection
    s = escapeFormula(s);
    // CSV-escape: wrap i " hvis indhold inkluderer delimiter/newline/"
    const needsWrap =
      s.includes(delimiter) || s.includes('\n') || s.includes('\r') || s.includes('"');
    if (needsWrap) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines: string[] = [];
  // Header
  lines.push(columns.map((c) => escapeCell(c.header)).join(delimiter));
  // Rows
  for (const row of rows) {
    const cells = columns.map((c) => escapeCell(row[c.key]));
    lines.push(cells.join(delimiter));
  }
  // UTF-8 BOM + CRLF line-endings (Excel-DK happy)
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  const buffer = Buffer.from(csv, 'utf8');
  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new Error(`CSV output ${buffer.length}B overstiger ${MAX_OUTPUT_BYTES}B limit`);
  }
  return {
    buffer,
    ext: 'csv',
    contentType: 'text/csv; charset=utf-8',
  };
}

// ─── Generator: DOCX ────────────────────────────────────────────────────

/**
 * Minimal DOCX genereret fra scratch via PizZip + inline OOXML. Undgår
 * et base-template-file i repoet (binary). Resultatet er en gyldig
 * .docx der åbner i Word/LibreOffice med:
 *   * title (heading 1)
 *   * valgfri subtitle (italic)
 *   * sections (heading 2 + body-paragraph)
 *
 * @param input - Valideret GenerateDocxInput
 */
export async function generateDocx(input: GenerateDocxInput): Promise<GeneratedFile> {
  const { default: PizZip } = await import('pizzip');

  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  // BIZZ-934: Track image files for DOCX embedding
  const imageFiles: Array<{ rId: string; buf: Buffer }> = [];

  // Body XML
  const paragraphs: string[] = [];
  paragraphs.push(
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(input.title)}</w:t></w:r></w:p>`
  );
  if (input.subtitle) {
    paragraphs.push(
      `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${esc(input.subtitle)}</w:t></w:r></w:p>`
    );
  }
  for (const section of input.sections) {
    paragraphs.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">${esc(section.heading)}</w:t></w:r></w:p>`
    );
    // Split body på newlines → ét paragraph pr linje
    const bodyLines = section.body.split(/\r?\n/);
    for (const line of bodyLines) {
      paragraphs.push(`<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`);
    }
    // BIZZ-934: Indlejr PNG-billede i DOCX hvis imageBase64 er sat
    if (section.imageBase64) {
      const imgIdx = imageFiles.length + 1;
      const rIdImg = `rIdImg${imgIdx}`;
      const imgBuf = Buffer.from(section.imageBase64, 'base64');
      imageFiles.push({ rId: rIdImg, buf: imgBuf });
      // EMU: 1 inch = 914400 EMU. ~6 inches wide, auto height (aspect ratio maintained by Word)
      const widthEmu = 5486400; // ~6 inches
      const heightEmu = 3200400; // ~3.5 inches (default — Word auto-scales)
      paragraphs.push(
        `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${imgIdx}" name="Diagram ${imgIdx}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imgIdx}" name="diagram.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rIdImg}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
      );
    }
  }

  // Build image relationships
  const imageRels = imageFiles
    .map(
      (img) =>
        `<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.rId}.png"/>`
    )
    .join('\n  ');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join('\n    ')}
  </w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${imageRels}
</Relationships>`;

  const zip = new PizZip();
  zip.file('[Content_Types].xml', contentTypesXml);
  zip.file('_rels/.rels', relsXml);
  zip.file('word/document.xml', documentXml);
  if (imageFiles.length > 0) {
    zip.file('word/_rels/document.xml.rels', wordRelsXml);
    for (const img of imageFiles) {
      zip.file(`word/media/${img.rId}.png`, img.buf);
    }
  }

  const buffer = Buffer.from(zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new Error(`DOCX output ${buffer.length}B overstiger ${MAX_OUTPUT_BYTES}B limit`);
  }
  return {
    buffer,
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

// ─── PPTX generator (BIZZ-935) ────────────────────────────────────────

/**
 * Genererer en PPTX-fil fra strukturerede slides med titler, bullet-punkter og tabeller.
 *
 * @param input - Slides med titler og indhold
 * @returns GeneratedFile med PPTX-buffer
 */
export async function generatePptx(input: GeneratePptxInput): Promise<GeneratedFile> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.author = 'BizzAssist AI';
  pres.title = input.title;

  // Titel-slide
  const titleSlide = pres.addSlide();
  titleSlide.background = { color: '0F172A' };
  titleSlide.addText(input.title, {
    x: 0.5,
    y: 2.0,
    w: 12.3,
    h: 1.5,
    fontSize: 32,
    bold: true,
    color: 'FFFFFF',
    align: 'center',
  });
  titleSlide.addText('BizzAssist', {
    x: 0.5,
    y: 4.0,
    w: 12.3,
    h: 0.5,
    fontSize: 14,
    color: '60A5FA',
    align: 'center',
  });

  // Indholds-slides
  for (const s of input.slides) {
    const slide = pres.addSlide();
    slide.background = { color: '0F172A' };

    // Slide-titel
    slide.addText(s.title, {
      x: 0.5,
      y: 0.3,
      w: 12.3,
      h: 0.8,
      fontSize: 24,
      bold: true,
      color: 'FFFFFF',
    });

    let yOffset = 1.3;

    // Bullet-punkter
    if (s.bullets && s.bullets.length > 0) {
      const bulletText = s.bullets.map((b) => ({
        text: b,
        options: { fontSize: 14, color: 'CBD5E1', bullet: { code: '2022' } },
      }));
      slide.addText(bulletText, {
        x: 0.5,
        y: yOffset,
        w: 12.3,
        h: Math.min(s.bullets.length * 0.5 + 0.5, 5),
        valign: 'top',
        paraSpaceAfter: 6,
      });
      yOffset += Math.min(s.bullets.length * 0.5 + 0.5, 5) + 0.2;
    }

    // Tabel
    if (s.table && s.table.columns.length > 0) {
      const headerRow = s.table.columns.map((c) => ({
        text: c,
        options: { bold: true, color: 'FFFFFF', fill: { color: '1E3A5F' }, fontSize: 11 },
      }));
      const dataRows = s.table.rows.map((row) =>
        row.map((cell) => ({
          text: cell,
          options: { color: 'CBD5E1', fill: { color: '1E293B' }, fontSize: 10 },
        }))
      );
      slide.addTable([headerRow, ...dataRows], {
        x: 0.5,
        y: yOffset,
        w: 12.3,
        border: { type: 'solid', pt: 0.5, color: '334155' },
        colW: Array(s.table.columns.length).fill(12.3 / s.table.columns.length),
      });
    }
  }

  const arrayBuffer = (await pres.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new Error(`PPTX output ${buffer.length}B overstiger ${MAX_OUTPUT_BYTES}B limit`);
  }
  return {
    buffer,
    ext: 'pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
}

// ─── Fill DOCX template ────────────────────────────────────────────────

/**
 * Fyld en DOCX-template med placeholder-værdier via docxtemplater.
 * Reuse af pattern fra app/api/domain/[id]/case/[caseId]/generate/route.ts
 * (BIZZ-744). Manglende placeholder → tom streng via nullGetter.
 *
 * @param templateBuffer - Rå .docx som Buffer
 * @param placeholders - Map placeholder-navn → værdi
 */
export async function fillDocxTemplate(
  templateBuffer: Buffer,
  placeholders: Record<string, string>
): Promise<GeneratedFile> {
  const { default: PizZip } = await import('pizzip');
  const { default: Docxtemplater } = await import('docxtemplater');
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
    // Manglende placeholder → tom streng (ikke kast)
    nullGetter: () => '',
  });
  doc.render(placeholders);
  const buffer = Buffer.from(doc.getZip().generate({ type: 'nodebuffer' }));
  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new Error(`DOCX output ${buffer.length}B overstiger ${MAX_OUTPUT_BYTES}B limit`);
  }
  return {
    buffer,
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

/**
 * Iter-2 stub: XLSX template-fill. Kræver at vi kan parse bruger-
 * uploadet XLSX, identificere placeholders (fx `{{navn}}` i cell-values)
 * og substituere. Ikke nødvendigt til MVP — brugeren kan bruge
 * generateXlsx med pre-filled rows i stedet.
 */
export async function fillXlsxTemplate(
  _templateBuffer: Buffer,
  _opts: { rows: Record<string, unknown>[]; placeholders?: Record<string, string> }
): Promise<GeneratedFile> {
  throw new Error(
    'fillXlsxTemplate er parkeret til iter 2. Brug generateXlsx med pre-filled rows indtil da.'
  );
}

/**
 * BIZZ-815: Parse en XLSX buffer til preview-friendly table-struktur.
 * Læser første sheet, bruger række 1 som header-labels og række 2+
 * som data. Cell-values stringifieres (Date → ISO-dato).
 *
 * Limits: Første 500 rækker + 50 kolonner — forhindrer at render-panel
 * bliver overbelastet ved store templates.
 *
 * @param buffer - Rå XLSX binær
 * @returns columns (header-strings) + rows (string-matrix)
 */
export async function xlsxToPreviewTable(buffer: Buffer): Promise<{
  columns: string[];
  rows: string[][];
}> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  // exceljs forventer ArrayBuffer; Node Buffer er assignable men TS-types
  // fanger det ikke i alle versioner — cast via .buffer-slice.
  const arrayBuf = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  await wb.xlsx.load(arrayBuf as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { columns: [], rows: [] };

  const PREVIEW_MAX_ROWS = 500;
  const PREVIEW_MAX_COLS = 50;

  const headerRow = sheet.getRow(1);
  const columns: string[] = [];
  const colCount = Math.min(sheet.columnCount, PREVIEW_MAX_COLS);
  for (let c = 1; c <= colCount; c++) {
    const cell = headerRow.getCell(c);
    columns.push(cellToString(cell.value));
  }

  const rows: string[][] = [];
  const rowLimit = Math.min(sheet.rowCount, PREVIEW_MAX_ROWS + 1); // +1 for header
  for (let r = 2; r <= rowLimit; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      cells.push(cellToString(row.getCell(c).value));
    }
    rows.push(cells);
  }
  return { columns, rows };
}

/**
 * BIZZ-815: Parse CSV buffer til preview-friendly table-struktur.
 * Håndterer: komma OG semikolon delimiters (auto-detect), UTF-8 BOM,
 * quoted fields med " + doubled-""-escape, CRLF/LF line-endings.
 */
export function csvToPreviewTable(buffer: Buffer): {
  columns: string[];
  rows: string[][];
} {
  let text = buffer.toString('utf8');
  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectCsvDelimiter(text);
  const parsed = parseCsv(text, delimiter);
  if (parsed.length === 0) return { columns: [], rows: [] };
  const [header, ...data] = parsed;
  return {
    columns: header,
    rows: data.slice(0, 500),
  };
}

/** Stringify exceljs cell-value. Handles Date + formula (takes result). */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value !== null) {
    // exceljs formula: { formula, result } → prefer result
    const obj = value as { result?: unknown; text?: unknown; richText?: unknown };
    if (obj.result !== undefined) return cellToString(obj.result);
    if (obj.text !== undefined) return String(obj.text);
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((r) => String((r as { text?: string }).text ?? '')).join('');
    }
    return String(value);
  }
  return String(value);
}

/**
 * BIZZ-868: Parse docx buffer til sanitiseret HTML for inline preview.
 * Mammoth returnerer minimal HTML (headings, paragraphs, lists, tables).
 * Vi stripper potentielt farlige tags server-side — DocPreviewPanel
 * injicerer resultatet via dangerouslySetInnerHTML.
 *
 * @param buffer - Raw docx-buffer
 * @returns {html, warnings} — html er sanitiseret, warnings er parse-warnings
 */
export async function docxToPreviewHtml(buffer: Buffer): Promise<{
  html: string;
  warnings: string[];
}> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ buffer });
  // Mammoth outputter kun et begrænset sæt tags (p, h1-h6, ul, ol, li, table,
  // tr, td, th, strong, em, a). Strip script/style/iframe/event-handlers for
  // sikkerhed — aldrig stol på input selv hvis kilden er vores egen.
  const sanitized = result.value
    // Fjern script/style/iframe indhold + tag (multiline)
    .replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Fjern selv-lukkende farlige tags
    .replace(/<(script|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
    // Fjern on*=handlers på alle tags
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Fjern javascript:-URLer
    .replace(/(\s(?:href|src)\s*=\s*)(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '$1"#"');
  return {
    html: sanitized,
    warnings: result.messages.map((m) => m.message),
  };
}

/** Auto-detect CSV delimiter ved at tælle forekomster på første linje. */
function detectCsvDelimiter(text: string): ',' | ';' {
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const semis = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return semis > commas ? ';' : ',';
}

/** Minimal RFC-4180 CSV parser med quoted-field + doubled-quote-escape. */
function parseCsv(text: string, delimiter: ',' | ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        if (ch === '\r' && text[i + 1] === '\n') i += 2;
        else i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // Sidste felt hvis no trailing newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
