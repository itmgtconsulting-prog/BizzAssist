/**
 * POST /api/export/pdf
 *
 * Generates a branded PDF report from property or company data.
 * Uses pdfkit for server-side PDF generation.
 *
 * BIZZ-274: PDF export for ejendomsrapport and virksomhedsrapport.
 *
 * @param request.body.type - 'property' | 'company'
 * @param request.body.data - The data object to render
 * @param request.body.title - Optional report title
 * @returns PDF file as application/pdf
 */

import { NextRequest, NextResponse } from 'next/server';
import { companyInfo } from '@/app/lib/companyInfo';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';
import { writeAuditLog } from '@/app/lib/auditLog';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST body */
const pdfExportBodySchema = z.object({
  type: z.enum(['property', 'company']),
  data: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
});

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Renders a labeled field in the PDF.
 */
function field(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string | number | null | undefined,
  y: number
): number {
  if (value == null || value === '') return y;
  doc.fontSize(8).fillColor('#94a3b8').text(label, 50, y);
  doc.fontSize(10).fillColor('#e2e8f0').text(String(value), 160, y);
  return y + 16;
}

/**
 * Renders a section heading in the PDF.
 */
function heading(doc: PDFKit.PDFDocument, text: string, y: number): number {
  if (y > 700) {
    doc.addPage();
    y = 50;
  }
  doc.fontSize(13).fillColor('#3b82f6').text(text, 50, y);
  doc
    .moveTo(50, y + 18)
    .lineTo(545, y + 18)
    .strokeColor('#1e293b')
    .lineWidth(0.5)
    .stroke();
  return y + 28;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, heavyRateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = await parseBody(request, pdfExportBodySchema);
  if (!parsed.success) return parsed.response;
  const { type, data, title } = parsed.data;

  try {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title:
          title ?? `BizzAssist ${type === 'property' ? 'Ejendomsrapport' : 'Virksomhedsrapport'}`,
        Author: `BizzAssist — ${companyInfo.name}`,
        Creator: 'BizzAssist PDF Export',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    // ── Header ──
    doc.rect(0, 0, 595, 70).fill('#0f172a');
    doc.fontSize(20).fillColor('#3b82f6').text('BizzAssist', 50, 22);
    doc
      .fontSize(8)
      .fillColor('#64748b')
      .text(type === 'property' ? 'Ejendomsrapport' : 'Virksomhedsrapport', 50, 46);
    doc
      .fontSize(7)
      .fillColor('#475569')
      .text(
        new Date().toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' }),
        400,
        28
      );

    // ── Body background ──
    doc.rect(0, 70, 595, 772).fill('#0a1020');

    let y = 90;

    if (type === 'property') {
      // Property report
      const d = data as Record<string, unknown>;
      y = heading(doc, title ?? String(d.adresse ?? 'Ejendomsrapport'), y);
      y = field(doc, 'Adresse', d.adresse as string, y);
      y = field(doc, 'Postnr / By', `${d.postnr ?? ''} ${d.by ?? ''}`, y);
      y = field(doc, 'Kommune', d.kommune as string, y);
      y = field(doc, 'BFE-nummer', d.bfeNummer as string, y);
      y = field(doc, 'Ejendomstype', d.ejendomstype as string, y);
      y += 10;

      if (d.vurdering) {
        const v = d.vurdering as Record<string, unknown>;
        y = heading(doc, 'Vurdering', y);
        y = field(
          doc,
          'Ejendomsværdi',
          v.ejendomsvaerdi ? `${Number(v.ejendomsvaerdi).toLocaleString('da-DK')} kr` : null,
          y
        );
        y = field(
          doc,
          'Grundværdi',
          v.grundvaerdi ? `${Number(v.grundvaerdi).toLocaleString('da-DK')} kr` : null,
          y
        );
        y = field(doc, 'Vurderingsår', v.aar as string, y);
        y += 10;
      }

      if (Array.isArray(d.bygninger) && d.bygninger.length > 0) {
        y = heading(doc, 'Bygninger', y);
        for (const b of d.bygninger as Record<string, unknown>[]) {
          y = field(doc, 'Anvendelse', b.anvendelse as string, y);
          y = field(doc, 'Opførelsesår', b.opfoerelsesaar as string, y);
          y = field(doc, 'Areal', b.samletBygningsareal ? `${b.samletBygningsareal} m²` : null, y);
          y = field(doc, 'Tagmateriale', b.tagmateriale as string, y);
          y += 6;
        }
      }
    } else if (type === 'company') {
      const d = data as Record<string, unknown>;
      y = heading(doc, title ?? String(d.name ?? 'Virksomhedsrapport'), y);
      y = field(doc, 'CVR', d.vat as string, y);
      y = field(doc, 'Navn', d.name as string, y);
      y = field(doc, 'Adresse', d.address as string, y);
      y = field(doc, 'Branche', d.industrydesc as string, y);
      y = field(doc, 'Virksomhedsform', d.companydesc as string, y);
      y = field(doc, 'Status', d.status as string, y);
      y = field(doc, 'Stiftet', d.startdate as string, y);
      y = field(doc, 'Ansatte', d.employees as string, y);
      y += 10;

      if (Array.isArray(d.owners) && d.owners.length > 0) {
        y = heading(doc, 'Ejere', y);
        for (const o of d.owners as Record<string, unknown>[]) {
          y = field(doc, o.erVirksomhed ? 'Virksomhed' : 'Person', o.navn as string, y);
          if (o.ejerandel) y = field(doc, 'Ejerandel', o.ejerandel as string, y);
          y += 4;
        }
      }
    }

    // ── Footer ──
    doc
      .fontSize(6)
      .fillColor('#475569')
      .text(`${companyInfo.legalLine} — Genereret automatisk`, 50, 790);

    doc.end();

    const pdf = await new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    const filename =
      type === 'property'
        ? `ejendomsrapport-${data.bfeNummer ?? 'unknown'}.pdf`
        : `virksomhedsrapport-${data.vat ?? 'unknown'}.pdf`;

    writeAuditLog({
      action: 'export.pdf',
      resource_type: type,
      resource_id: String(data.bfeNummer ?? data.vat ?? 'unknown'),
    });

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    logger.error('[export/pdf] PDF generation error:', err);
    return NextResponse.json({ error: 'PDF generation fejlede' }, { status: 500 });
  }
}
