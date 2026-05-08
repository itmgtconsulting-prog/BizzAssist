/**
 * POST /api/ai/export-listing-pdf
 *
 * BIZZ-1183: Genererer en PDF med professionelt mæglerlayout fra en
 * annoncetekst. PDFKit bruges server-side til at bygge dokumentet.
 *
 * Input: { adresse, annonceTekst, bfe?, tone? }
 * Output: application/pdf blob
 *
 * Layout:
 *   - Header med BizzAssist-branding + adresse
 *   - Annoncetekst (markdown → formateret)
 *   - Fakta-boks (BFE, tone)
 *   - Footer med QR-kode-placeholder og disclaimer
 *
 * @retention Ingen data persisteres — ren PDF-generation.
 */

import { NextRequest, NextResponse } from 'next/server';
import PDFDocument from 'pdfkit';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { companyInfo } from '@/app/lib/companyInfo';

export const runtime = 'nodejs';
export const maxDuration = 15;

/** Request body */
interface ExportPdfBody {
  adresse: string;
  annonceTekst: string;
  bfe?: number;
  tone?: string;
}

/**
 * Strip simple markdown (**, ##) for PDF plain-text rendering.
 *
 * @param text - Markdown text
 * @returns Cleaned text + extracted headings
 */
function parseMarkdown(text: string): { headings: string[]; body: string } {
  const headings: string[] = [];
  const lines = text.split('\n');
  const bodyLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      headings.push(headingMatch[1].replace(/\*\*/g, ''));
      bodyLines.push('');
    } else {
      bodyLines.push(line.replace(/\*\*/g, ''));
    }
  }

  return { headings, body: bodyLines.join('\n').trim() };
}

/**
 * POST handler — genererer PDF fra annoncetekst.
 *
 * @param request - POST request med adresse og annonceTekst
 * @returns PDF response
 */
export async function POST(request: NextRequest): Promise<NextResponse | Response> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  let body: ExportPdfBody;
  try {
    body = (await request.json()) as ExportPdfBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.adresse || !body.annonceTekst) {
    return NextResponse.json({ error: 'Mangler adresse eller annonceTekst' }, { status: 400 });
  }

  // Build PDF
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: `Boligannonce — ${body.adresse}`,
      Author: companyInfo.name,
      Creator: 'BizzAssist AI Annonce-generator',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const pdfPromise = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  // ── Header ────────────────────────────────────────────────────────────────
  doc
    .fontSize(10)
    .fillColor('#94a3b8')
    .text('BizzAssist', 50, 40, { continued: true })
    .fillColor('#64748b')
    .text(`  |  ${companyInfo.name}`, { continued: false });

  doc.moveTo(50, 60).lineTo(545, 60).strokeColor('#334155').lineWidth(0.5).stroke();

  // ── Overskrift (adresse) ──────────────────────────────────────────────────
  doc.moveDown(1);
  doc.fontSize(22).fillColor('#f1f5f9').text(body.adresse, 50, 75);

  if (body.tone) {
    doc.moveDown(0.3).fontSize(10).fillColor('#10b981').text(`Tone: ${body.tone}`, 50);
  }

  // ── Annoncetekst ──────────────────────────────────────────────────────────
  doc.moveDown(1);

  const { headings, body: cleanBody } = parseMarkdown(body.annonceTekst);

  // Vis første heading som undertitel
  if (headings[0]) {
    doc.fontSize(16).fillColor('#e2e8f0').text(headings[0], 50);
    doc.moveDown(0.5);
  }

  // Brødtekst
  doc.fontSize(11).fillColor('#cbd5e1').text(cleanBody, 50, undefined, {
    width: 495,
    lineGap: 4,
    paragraphGap: 8,
  });

  // ── Fakta-boks ────────────────────────────────────────────────────────────
  const currentY = doc.y + 20;
  if (currentY < 700) {
    doc.rect(50, currentY, 495, 40).fillAndStroke('#1e293b', '#334155');
    doc
      .fontSize(9)
      .fillColor('#94a3b8')
      .text(
        `BFE: ${body.bfe ?? '-'}  |  Genereret: ${new Date().toLocaleDateString('da-DK')}  |  AI-genereret forslag — gennemgå før brug`,
        60,
        currentY + 13,
        { width: 475 }
      );
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  doc
    .fontSize(8)
    .fillColor('#475569')
    .text(`${companyInfo.legalLine}  |  bizzassist.dk/ejendom/${body.bfe ?? ''}`, 50, 770, {
      width: 495,
      align: 'center',
    });

  doc.end();

  const pdfBuffer = await pdfPromise;

  const filename = `annonce-${body.bfe ?? 'ejendom'}-${Date.now()}.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(pdfBuffer.length),
    },
  });
}
