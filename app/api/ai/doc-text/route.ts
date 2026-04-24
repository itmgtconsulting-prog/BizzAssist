/**
 * GET /api/ai/doc-text?docId=X
 *
 * BIZZ-902 (parent BIZZ-896): Henter extracted_text fra et domain_case_doc
 * for brug i AI-chat-kontekst. Tool-handler hent_dokument_indhold kalder
 * dette endpoint for hver valgt dokument-ID.
 *
 * Auth-model: ingen eksplicit domainId i URL — i stedet opslår vi docId
 * → case → domain og kalder assertDomainMember. Kombinerer "hvem ejer
 * dokumentet" + "er brugeren medlem af det domain" i én round-trip, så
 * AI-tool kan kaldes med kun docId.
 *
 * GDPR: extracted_text kan indeholde PII fra kunde-dokumenter. Endpoint
 * er service_role (via admin client) men gated af domain-membership.
 * Logging indeholder aldrig tekst-content — kun id, doc-navn, og
 * tekst-længde.
 *
 * Retention: extracted_text følger domain_case_doc lifecycle (30-dages
 * soft-delete, derefter hard-delete via retention-cron).
 *
 * @param docId - domain_case_doc.id (UUID)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember } from '@/app/lib/domainAuth';
import { isDomainFeatureEnabled } from '@/app/lib/featureFlags';
import { logger } from '@/app/lib/logger';

const querySchema = z.object({
  docId: z.string().uuid(),
});

interface DocTextResponse {
  docId: string;
  name: string;
  fileType: string;
  extractedText: string | null;
  /** Længde af extractedText i tegn — lavet synlig så caller kan cap'e payload. */
  textLength: number;
  /** ISO-timestamp hvor dokumentet blev uploaded/oprettet. */
  createdAt: string;
  fejl?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse<DocTextResponse>> {
  if (!isDomainFeatureEnabled()) {
    return NextResponse.json(
      {
        docId: '',
        name: '',
        fileType: '',
        extractedText: null,
        textLength: 0,
        createdAt: '',
        fejl: 'Domain feature not enabled',
      },
      { status: 404 }
    );
  }

  const parsed = querySchema.safeParse({
    docId: request.nextUrl.searchParams.get('docId'),
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        docId: '',
        name: '',
        fileType: '',
        extractedText: null,
        textLength: 0,
        createdAt: '',
        fejl: 'docId skal være en gyldig UUID',
      },
      { status: 400 }
    );
  }

  const { docId } = parsed.data;

  try {
    // Step 1: Opslag docId → case_id → domain_id (join via case-relation).
    // Bypass domainScopedQuery her: vi kender endnu ikke domain_id —
    // det er netop dét vi slår op for at kunne authorize. Samme pattern
    // som /api/domain/[id]/cases/[caseId]/docs/[docId] fetchDoc.
    const admin = createAdminClient();
    // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-explicit-any
    const { data: doc } = (await (admin as any)
      .from('domain_case_doc')
      .select(
        'id, name, file_type, extracted_text, created_at, deleted_at, case:case_id (domain_id)'
      )
      .eq('id', docId)
      .maybeSingle()) as {
      data: {
        id: string;
        name: string;
        file_type: string;
        extracted_text: string | null;
        created_at: string;
        deleted_at: string | null;
        case: { domain_id: string } | null;
      } | null;
    };

    if (!doc) {
      return NextResponse.json(
        {
          docId,
          name: '',
          fileType: '',
          extractedText: null,
          textLength: 0,
          createdAt: '',
          fejl: 'Dokument ikke fundet',
        },
        { status: 404 }
      );
    }
    if (doc.deleted_at) {
      return NextResponse.json(
        {
          docId,
          name: doc.name,
          fileType: doc.file_type,
          extractedText: null,
          textLength: 0,
          createdAt: doc.created_at,
          fejl: 'Dokumentet er slettet',
        },
        { status: 410 }
      );
    }
    const domainId = doc.case?.domain_id;
    if (!domainId) {
      return NextResponse.json(
        {
          docId,
          name: doc.name,
          fileType: doc.file_type,
          extractedText: null,
          textLength: 0,
          createdAt: doc.created_at,
          fejl: 'Dokument har ingen domain-relation',
        },
        { status: 404 }
      );
    }

    // Step 2: Authorize — bruger skal være medlem af dokumentets domain.
    // assertDomainMember kaster Error('Forbidden') ved miss.
    try {
      await assertDomainMember(domainId);
    } catch {
      return NextResponse.json(
        {
          docId,
          name: doc.name,
          fileType: doc.file_type,
          extractedText: null,
          textLength: 0,
          createdAt: doc.created_at,
          fejl: 'Forbidden',
        },
        { status: 403 }
      );
    }

    const text = doc.extracted_text ?? '';
    return NextResponse.json({
      docId,
      name: doc.name,
      fileType: doc.file_type,
      extractedText: text,
      textLength: text.length,
      createdAt: doc.created_at,
    });
  } catch (err) {
    logger.error('[ai/doc-text] fetch error:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      {
        docId,
        name: '',
        fileType: '',
        extractedText: null,
        textLength: 0,
        createdAt: '',
        fejl: 'Ekstern API fejl',
      },
      { status: 500 }
    );
  }
}
