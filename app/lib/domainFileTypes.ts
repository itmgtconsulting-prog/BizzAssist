/**
 * BIZZ-788: Shared file-type support for all domain uploads (templates,
 * training docs, case docs).
 *
 * Mapper MIME-types (og filendelser som fallback) til en normaliseret
 * file_type-nøgle. Supporterer alle formater Claude enten kan læse direkte
 * (PDF, plain text) eller vi kan parse server-side til tekst (docx, xlsx,
 * pptx, html, md, csv, json, xml, yaml, rtf, eml).
 *
 * Images (PNG/JPG/GIF/WEBP) er inkluderet — Claude læser dem via vision.
 * Hvis vi senere vil sende dem til generation-pipelinen, skal
 * domainTextExtraction.ts håndtere dem separat (skip tekst, pass bytes).
 *
 * @module app/lib/domainFileTypes
 */

/** Normaliseret file_type-nøgle på tværs af upload-endpoints. */
export type NormalizedFileType =
  // Office documents (parsed server-side)
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'rtf'
  // Document containers
  | 'pdf'
  // Structured / plain text
  | 'txt'
  | 'md'
  | 'html'
  | 'csv'
  | 'tsv'
  | 'json'
  | 'xml'
  | 'yaml'
  | 'log'
  // Email
  | 'eml'
  | 'msg'
  // Source code (all parsed as plain text)
  | 'code'
  // Images (Claude vision)
  | 'image';

interface TypeSpec {
  /** Normaliseret file_type-kategori (gemmes i DB). */
  type: NormalizedFileType;
  /** Matchende filendelser (uden punktum, lowercase). */
  extensions: readonly string[];
  /** Human-readable label til UI og fejlbeskeder. */
  label: string;
}

// Ordered list — first match wins. Covers all formats Claude can consume
// either natively (PDF, plain text, images) or after server-side parsing
// (docx via mammoth, xlsx via exceljs, pptx via jszip, etc.).
const SPECS: readonly TypeSpec[] = [
  // Word
  {
    type: 'docx',
    extensions: ['docx'],
    label: 'Word (.docx)',
  },
  // Excel
  {
    type: 'xlsx',
    extensions: ['xlsx', 'xlsm', 'xls'],
    label: 'Excel (.xlsx)',
  },
  // PowerPoint
  {
    type: 'pptx',
    extensions: ['pptx'],
    label: 'PowerPoint (.pptx)',
  },
  // Rich text
  {
    type: 'rtf',
    extensions: ['rtf'],
    label: 'Rich Text (.rtf)',
  },
  // PDF
  {
    type: 'pdf',
    extensions: ['pdf'],
    label: 'PDF',
  },
  // Markdown (check before html/txt so .md doesn't fall through to txt)
  {
    type: 'md',
    extensions: ['md', 'markdown'],
    label: 'Markdown',
  },
  // HTML
  {
    type: 'html',
    extensions: ['html', 'htm'],
    label: 'HTML',
  },
  // CSV / TSV
  {
    type: 'csv',
    extensions: ['csv'],
    label: 'CSV',
  },
  {
    type: 'tsv',
    extensions: ['tsv'],
    label: 'TSV',
  },
  // Structured data
  {
    type: 'json',
    extensions: ['json', 'jsonl', 'ndjson'],
    label: 'JSON',
  },
  {
    type: 'xml',
    extensions: ['xml', 'xhtml'],
    label: 'XML',
  },
  {
    type: 'yaml',
    extensions: ['yaml', 'yml'],
    label: 'YAML',
  },
  // Logs
  {
    type: 'log',
    extensions: ['log'],
    label: 'Log',
  },
  // Email
  {
    type: 'eml',
    extensions: ['eml'],
    label: 'Email (.eml)',
  },
  {
    type: 'msg',
    extensions: ['msg'],
    label: 'Outlook (.msg)',
  },
  // Source code — wide list that covers all common languages
  {
    type: 'code',
    extensions: [
      'js',
      'jsx',
      'ts',
      'tsx',
      'mjs',
      'cjs',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'swift',
      'c',
      'h',
      'cpp',
      'hpp',
      'cc',
      'cs',
      'php',
      'sh',
      'bash',
      'zsh',
      'fish',
      'sql',
      'r',
      'scala',
      'pl',
      'lua',
      'dart',
      'css',
      'scss',
      'sass',
      'less',
      'vue',
      'svelte',
      'tex',
      'toml',
      'ini',
      'env',
      'conf',
      'properties',
    ],
    label: 'Source code',
  },
  // Plain text (check last so other text-based types match first)
  {
    type: 'txt',
    extensions: ['txt', 'text'],
    label: 'Plain text',
  },
  // Images
  {
    type: 'image',
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    label: 'Image',
  },
];

/**
 * MIME-type → normalized type. Explicit entries ensure we always get the
 * right category even when the browser provides a MIME that doesn't match
 * the common extension mapping.
 */
const MIME_MAP: Record<string, NormalizedFileType> = {
  // Office
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  // PDF
  'application/pdf': 'pdf',
  // Text
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/json': 'json',
  'application/ld+json': 'json',
  'text/json': 'json',
  'application/x-ndjson': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
  'text/x-yaml': 'yaml',
  'application/yaml': 'yaml',
  'text/x-log': 'log',
  // Email
  'message/rfc822': 'eml',
  'application/vnd.ms-outlook': 'msg',
  // Source code — most come through as text/plain or application/octet-stream
  'text/javascript': 'code',
  'application/javascript': 'code',
  'application/typescript': 'code',
  'text/x-python': 'code',
  'application/x-python-code': 'code',
  'text/x-ruby': 'code',
  'text/x-go': 'code',
  'text/x-rust': 'code',
  'text/x-java-source': 'code',
  'text/x-c': 'code',
  'text/x-c++src': 'code',
  'text/x-csharp': 'code',
  'text/x-php': 'code',
  'application/x-sh': 'code',
  'text/x-sh': 'code',
  'application/sql': 'code',
  'text/x-sql': 'code',
  'text/css': 'code',
  'text/x-toml': 'code',
  // Images
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
};

/**
 * Resolve en upload til en normaliseret file_type-kategori.
 * MIME-typen vinder hvis den er kendt; ellers fallback til filendelse.
 * Returnerer null hvis hverken MIME eller endelse matcher et supporteret format.
 */
export function resolveFileType(
  mime: string | undefined,
  fileName: string
): NormalizedFileType | null {
  const normalizedMime = (mime ?? '').toLowerCase().split(';')[0].trim();
  const byMime = MIME_MAP[normalizedMime];
  if (byMime) return byMime;

  const ext = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
    : '';
  if (!ext) return null;
  for (const spec of SPECS) {
    if (spec.extensions.includes(ext)) return spec.type;
  }
  return null;
}

/** En kort, human-readable liste over understøttede formater (til fejlbeskeder). */
export function supportedLabels(): string {
  const labels = SPECS.map((s) => s.label);
  return labels.join(', ');
}

/** HTML `accept`-attribut der matcher alle understøttede endelser. */
export function fileInputAcceptString(): string {
  const all = SPECS.flatMap((s) => s.extensions.map((e) => `.${e}`));
  return all.join(',');
}

/** Om en file_type kan tekst-ekstraheres server-side (ikke image). */
export function isExtractable(type: NormalizedFileType): boolean {
  return type !== 'image';
}
