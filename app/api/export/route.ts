/**
 * POST /api/export
 *
 * Generates an Excel (.xlsx) file from property or company data.
 * Accepts a JSON body with a `type` field ('property' or 'company')
 * and the corresponding data payload.
 *
 * @param request.body.type - 'property' | 'company'
 * @param request.body.data - The data object to export
 * @returns .xlsx file as application/octet-stream
 */

import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';

/** Header style for the worksheet */
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A5F' },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: 'FFFFFFFF' },
  size: 11,
};

/**
 * Add a styled header row to a worksheet.
 *
 * @param ws - The worksheet to add the header to
 * @param headers - Column header strings
 */
function addHeader(ws: ExcelJS.Worksheet, headers: string[]) {
  const row = ws.addRow(headers);
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  row.height = 24;
}

/**
 * Build property Excel workbook with building + unit sheets.
 *
 * @param data - Property data payload from the client
 * @returns ExcelJS Workbook
 */
function buildPropertyWorkbook(data: Record<string, unknown>): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BizzAssist';
  wb.created = new Date();

  // ── Overview sheet ──
  const overview = wb.addWorksheet('Oversigt');
  addHeader(overview, ['Felt', 'Værdi']);
  overview.getColumn(1).width = 30;
  overview.getColumn(2).width = 50;

  const address = data.adresse as string | undefined;
  const postnr = data.postnr as string | undefined;
  const by = data.by as string | undefined;
  const kommune = data.kommune as string | undefined;
  const matrikel = data.matrikel as string | undefined;

  const infoRows: [string, string][] = [
    ['Adresse', address ?? ''],
    ['Postnummer', postnr ?? ''],
    ['By', by ?? ''],
    ['Kommune', kommune ?? ''],
    ['Matrikel', matrikel ?? ''],
  ];
  infoRows.forEach((r) => overview.addRow(r));

  // ── Buildings sheet ──
  const buildings = data.bygninger as Record<string, unknown>[] | undefined;
  if (buildings && buildings.length > 0) {
    const bSheet = wb.addWorksheet('Bygninger');
    const bHeaders = [
      'Anvendelse',
      'Status',
      'Opførelsesår',
      'Ombygningsår',
      'Samlet areal (m²)',
      'Boligareal (m²)',
      'Erhvervsareal (m²)',
      'Bebygget areal (m²)',
      'Etager',
      'Tagmateriale',
      'Ydervægge',
      'Varmeinstallation',
      'Opvarmningsform',
      'Supplerende varme',
      'Vandforsyning',
      'Afløbsforhold',
      'Bevaringsværdighed',
    ];
    addHeader(bSheet, bHeaders);
    bHeaders.forEach((_, i) => {
      bSheet.getColumn(i + 1).width = i === 0 ? 30 : 20;
    });

    buildings.forEach((b) => {
      bSheet.addRow([
        b.anvendelse ?? '',
        b.status ?? '',
        b.opfoerelsesaar ?? '',
        b.ombygningsaar ?? '',
        b.samletAreal ?? '',
        b.boligAreal ?? '',
        b.erhvervsAreal ?? '',
        b.bebyggetAreal ?? '',
        b.etager ?? '',
        b.tagMateriale ?? '',
        b.ydervaegMateriale ?? '',
        b.varmeinstallation ?? '',
        b.opvarmningsform ?? '',
        b.supplerendeVarme ?? '',
        b.vandforsyning ?? '',
        b.afloebsforhold ?? '',
        b.bevaringsvaerdighed ?? '',
      ]);
    });
  }

  // ── Units sheet ──
  const units = data.enheder as Record<string, unknown>[] | undefined;
  if (units && units.length > 0) {
    const uSheet = wb.addWorksheet('Enheder');
    const uHeaders = [
      'Anvendelse',
      'Boligtype',
      'Samlet areal (m²)',
      'Beboelsesareal (m²)',
      'Erhvervsareal (m²)',
      'Værelser',
      'Energiforsyning',
      'Status',
    ];
    addHeader(uSheet, uHeaders);
    uHeaders.forEach((_, i) => {
      uSheet.getColumn(i + 1).width = i === 0 ? 30 : 18;
    });

    units.forEach((u) => {
      uSheet.addRow([
        u.anvendelse ?? '',
        u.boligtype ?? '',
        u.samletAreal ?? '',
        u.beboelsesAreal ?? '',
        u.erhvervsAreal ?? '',
        u.vaerelser ?? '',
        u.energiforsyning ?? '',
        u.status ?? '',
      ]);
    });
  }

  // ── Valuations sheet ──
  const valuations = data.vurderinger as Record<string, unknown>[] | undefined;
  if (valuations && valuations.length > 0) {
    const vSheet = wb.addWorksheet('Vurderinger');
    const vHeaders = ['År', 'Ejendomsværdi (kr)', 'Grundværdi (kr)', 'Type'];
    addHeader(vSheet, vHeaders);
    vHeaders.forEach((_, i) => {
      vSheet.getColumn(i + 1).width = 22;
    });
    valuations.forEach((v) => {
      vSheet.addRow([
        v.aar ?? v.year ?? '',
        v.ejendomsvaerdi ?? v.propertyValue ?? '',
        v.grundvaerdi ?? v.landValue ?? '',
        v.type ?? '',
      ]);
    });
  }

  return wb;
}

/**
 * Build company Excel workbook.
 *
 * @param data - Company data payload from the client
 * @returns ExcelJS Workbook
 */
function buildCompanyWorkbook(data: Record<string, unknown>): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BizzAssist';
  wb.created = new Date();

  const overview = wb.addWorksheet('Virksomhed');
  addHeader(overview, ['Felt', 'Værdi']);
  overview.getColumn(1).width = 30;
  overview.getColumn(2).width = 50;

  const rows: [string, string][] = [
    ['CVR', String(data.cvr ?? '')],
    ['Navn', String(data.name ?? data.navn ?? '')],
    ['Virksomhedsform', String(data.companyForm ?? data.virksomhedsform ?? '')],
    ['Branche', String(data.industry ?? data.branche ?? '')],
    ['Adresse', String(data.address ?? data.adresse ?? '')],
    ['Telefon', String(data.phone ?? data.telefon ?? '')],
    ['E-mail', String(data.email ?? '')],
    ['Status', String(data.status ?? '')],
    ['Stiftet', String(data.founded ?? data.stiftet ?? '')],
    ['Antal ansatte', String(data.employees ?? data.ansatte ?? '')],
    ['Kreditstatus', String(data.creditStatus ?? data.kreditstatus ?? '')],
  ];
  rows.forEach((r) => overview.addRow(r));

  // ── Owners sheet ──
  const owners = data.owners as Record<string, unknown>[] | undefined;
  if (owners && owners.length > 0) {
    const oSheet = wb.addWorksheet('Ejere');
    addHeader(oSheet, ['Navn', 'Ejerandel']);
    oSheet.getColumn(1).width = 40;
    oSheet.getColumn(2).width = 20;
    owners.forEach((o) => {
      oSheet.addRow([o.navn ?? o.name ?? '', o.ejerandel ?? o.share ?? '']);
    });
  }

  // ── Production units sheet ──
  const pUnits = data.productionUnits as Record<string, unknown>[] | undefined;
  if (pUnits && pUnits.length > 0) {
    const pSheet = wb.addWorksheet('P-enheder');
    addHeader(pSheet, ['P-nummer', 'Navn', 'Branche', 'Adresse', 'Type']);
    [20, 40, 30, 40, 15].forEach((w, i) => {
      pSheet.getColumn(i + 1).width = w;
    });
    pUnits.forEach((p) => {
      pSheet.addRow([
        p.pnr ?? p.pNumber ?? '',
        p.navn ?? p.name ?? '',
        p.branche ?? p.industry ?? '',
        p.adresse ?? p.address ?? '',
        p.type ?? '',
      ]);
    });
  }

  return wb;
}

export async function POST(request: NextRequest) {
  // BIZZ-164: Require authentication before generating any export
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Rate limit: 60 req/min (standard)
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  try {
    const body = await request.json();
    const { type, data } = body as {
      type: 'property' | 'company';
      data: Record<string, unknown>;
    };

    if (!type || !data) {
      return NextResponse.json({ error: 'Missing type or data' }, { status: 400 });
    }

    const wb = type === 'property' ? buildPropertyWorkbook(data) : buildCompanyWorkbook(data);

    const buffer = await wb.xlsx.writeBuffer();

    const filename =
      type === 'property'
        ? `ejendom-${((data.adresse as string) || 'export').replace(/[^a-zA-Z0-9æøåÆØÅ]/g, '_')}.xlsx`
        : `virksomhed-CVR${data.cvr ?? 'export'}.xlsx`;

    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('[/api/export] Error:', err);
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}
