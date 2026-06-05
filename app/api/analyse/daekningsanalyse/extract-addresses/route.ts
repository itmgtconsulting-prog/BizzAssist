/**
 * AI address extraction — POST /api/analyse/daekningsanalyse/extract-addresses
 *
 * BIZZ-2025: Takes any uploaded file (PDF, DOCX, XLSX, CSV, TXT, image),
 * sends content to Claude for address extraction, and returns an array of
 * Danish addresses. Token usage is tracked against user's account.
 *
 * Flow:
 *   1. assertAiAllowed — check user subscription + token budget
 *   2. Parse file content (text extraction based on mime type)
 *   3. Send to Claude with extraction prompt
 *   4. recordAiUsage — debit tokens from user's account
 *   5. Return extracted addresses
 *
 * @module app/api/analyse/daekningsanalyse/extract-addresses/route
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requireModuleAccess } from '@/app/lib/serverModuleAccess';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { recordAiUsage } from '@/app/lib/aiTracking';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const maxDuration = 60;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const EXTRACTION_PROMPT = `Du er en adresse-ekstraktor. Gennemgå det vedlagte dokument og ekstraker ALLE danske adresser du kan finde.

Returner adresserne som en JSON-array af strings. Hver adresse skal være en komplet dansk adresse med vejnavn, husnummer, evt. etage/dør, postnummer og by.

Eksempel output:
["Godsparken 2, 2670 Greve", "Frederiksberg Alle 37, 3. th, 1820 Frederiksberg C"]

Regler:
- Ekstraker KUN danske adresser (postnummer er 4 cifre)
- Inkluder etage/dør hvis tilgængelig (f.eks. "3. th", "st. tv", "1. 2")
- Ignorer forretningsadresser/hovedkontor-adresser medmindre de tydeligt er kundeadresser
- Ignorer duplikater
- Returner tom array [] hvis ingen adresser findes
- Returner KUN JSON-arrayet, ingen anden tekst`;

/**
 * Extract text content from uploaded file based on mime type.
 *
 * @param file - Uploaded file
 * @returns Text content for Claude, or base64 for images
 */
async function extractFileContent(
  file: File
): Promise<{ text: string; isImage: boolean; mimeType: string }> {
  const mime = file.type || '';
  const name = file.name.toLowerCase();

  // CSV / TXT — direct text
  if (
    mime.includes('csv') ||
    mime.includes('text') ||
    name.endsWith('.csv') ||
    name.endsWith('.txt')
  ) {
    return { text: await file.text(), isImage: false, mimeType: mime };
  }

  // Excel — extract with exceljs
  if (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls')
  ) {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const buf = await file.arrayBuffer();
    await wb.xlsx.load(buf);
    const lines: string[] = [];
    for (const ws of wb.worksheets) {
      ws.eachRow((row) => {
        const cells = row.values as (string | number | null)[];
        const line = cells.filter(Boolean).map(String).join(' | ');
        if (line.trim()) lines.push(line);
      });
    }
    return { text: lines.join('\n'), isImage: false, mimeType: mime };
  }

  // PDF — extract text via raw buffer (Claude can read PDF content)
  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    const buf = Buffer.from(await file.arrayBuffer());
    return { text: buf.toString('base64'), isImage: false, mimeType: 'application/pdf' };
  }

  // Images — base64 for Claude vision
  if (mime.startsWith('image/') || name.match(/\.(png|jpg|jpeg|gif|webp)$/)) {
    const buf = Buffer.from(await file.arrayBuffer());
    return { text: buf.toString('base64'), isImage: true, mimeType: mime || 'image/png' };
  }

  // Word — extract as raw text (best effort)
  if (mime.includes('word') || name.endsWith('.docx') || name.endsWith('.doc')) {
    const buf = Buffer.from(await file.arrayBuffer());
    // Extract readable text from docx XML
    const content = buf.toString('utf-8').replace(/[^\x20-\x7E\xC0-\xFF\n]/g, ' ');
    // Find text between XML tags
    const textMatches = content.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
    if (textMatches) {
      const text = textMatches.map((m) => m.replace(/<[^>]+>/g, '')).join(' ');
      return { text, isImage: false, mimeType: mime };
    }
    return { text: content.slice(0, 50000), isImage: false, mimeType: mime };
  }

  // Fallback — try as text
  return { text: await file.text(), isImage: false, mimeType: mime };
}

/**
 * POST /api/analyse/daekningsanalyse/extract-addresses
 *
 * @param req - Multipart form data with 'file' field
 * @returns JSON with { addresses: string[], tokensUsed: number }
 */
export async function POST(req: NextRequest): Promise<NextResponse | Response> {
  // Module access guard
  const blocked = await requireModuleAccess('daekningsanalyse');
  if (blocked) return blocked;

  const tenant = await resolveTenantId();
  if (!tenant?.tenantId || !tenant.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // AI billing gate — check subscription + token budget
  const aiBlocked = await assertAiAllowed(tenant.userId);
  if (aiBlocked) return aiBlocked as unknown as NextResponse;

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 });
    }

    // Extract content from file
    const { text, isImage, mimeType } = await extractFileContent(file);
    if (!text) {
      return NextResponse.json({ error: 'Could not extract content from file' }, { status: 400 });
    }

    // Build Claude message
    const apiKey = process.env.BIZZASSIST_CLAUDE_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'AI not configured' }, { status: 503 });
    }

    const client = new Anthropic({ apiKey });

    type ContentBlock = Anthropic.Messages.ContentBlockParam;
    const content: ContentBlock[] = [];

    if (isImage) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType as 'image/png', data: text },
      });
    } else if (mimeType === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: text },
      });
    } else {
      // Truncate to ~100K chars to stay within token limits
      const truncated = text.length > 100000 ? text.slice(0, 100000) + '\n[...truncated]' : text;
      content.push({ type: 'text', text: `Dokument-indhold:\n\n${truncated}` });
    }

    content.push({ type: 'text', text: EXTRACTION_PROMPT });

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content }],
    });

    // Track token usage
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    await recordAiUsage({
      userId: tenant.userId,
      tenantId: tenant.tenantId,
      route: '/api/analyse/daekningsanalyse/extract-addresses',
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      model: CLAUDE_MODEL,
    });

    // Parse Claude's response
    const responseText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let addresses: string[] = [];
    try {
      // Extract JSON array from response (Claude may wrap it in markdown)
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        addresses = JSON.parse(jsonMatch[0]);
      }
    } catch {
      logger.warn(
        '[extract-addresses] Failed to parse Claude response:',
        responseText.slice(0, 200)
      );
    }

    // Filter to valid Danish addresses (must contain 4-digit postnr)
    addresses = addresses.filter((a) => typeof a === 'string' && a.match(/\d{4}\s/));

    // Deduplicate
    addresses = [...new Set(addresses)];

    return NextResponse.json({
      addresses,
      tokensUsed: totalTokens,
      fileName: file.name,
    });
  } catch (err) {
    logger.error('[extract-addresses] Error:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
