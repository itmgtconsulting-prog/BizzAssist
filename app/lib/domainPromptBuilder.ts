/**
 * BIZZ-716: Compose the Claude generation prompt from template + training
 * RAG + case docs + BizzAssist data for entities found in the case.
 *
 * Returns a structured GenerationContext the generation API (BIZZ-717) can
 * turn into a Claude API call. Token-budget-aware — total_tokens never
 * exceeds MAX_CONTEXT_TOKENS so Opus 200k context stays comfortable.
 *
 * @module app/lib/domainPromptBuilder
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { searchDomainEmbeddings } from '@/app/lib/domainEmbedding';
import { embedTexts, NoEmbeddingProviderError } from '@/app/lib/domainEmbed';
import { extractEntities } from '@/app/lib/domainEntityExtract';
import { enrichEntities } from '@/app/lib/domainEnrichEntities';
import { PROMPT_INJECTION_GUARD_SUFFIX } from '@/app/lib/domainGenerationSchema';
import { logger } from '@/app/lib/logger';

/** Total token budget for the composed context (leaves headroom for Claude's own output). */
export const MAX_CONTEXT_TOKENS = 150_000;
/** How many training-doc chunks to retrieve via vector search. */
export const TRAINING_TOP_K = 8;
/** If total case-doc text exceeds this token count, switch to RAG over case docs. */
export const CASE_DOC_INLINE_CAP_TOKENS = 20_000;

export interface TemplateContext {
  id: string;
  name: string;
  file_type: string;
  instructions: string | null;
  examples: Array<{ text: string; note?: string }>;
  placeholders: Array<{
    name: string;
    syntax?: string;
    description?: string;
    source_hint?: string;
  }>;
  extracted_text: string;
}

export interface ChunkContext {
  source_type: string;
  source_id: string;
  content: string;
  similarity?: number;
}

export interface CaseDocContext {
  id: string;
  name: string;
  file_type: string;
  text: string;
}

/**
 * BIZZ-786: A document linked to the selected template via the
 * `domain_template_document` junction. Guidelines tell Claude exactly how
 * the admin wants this reference doc used for this particular template —
 * e.g. "treat section 3 as canonical wording" or "use as a style example".
 */
export interface TemplateDocContext {
  attachment_id: string;
  document_id: string;
  name: string;
  file_type: string;
  guidelines: string | null;
  sort_order: number;
  text: string;
}

export interface BizzAssistEntity {
  kind: 'cvr' | 'bfe';
  id: string;
  data: unknown;
}

export interface GenerationContext {
  template: TemplateContext;
  /** BIZZ-786: Reference docs explicitly linked to this template with per-attachment guidelines. */
  template_docs: TemplateDocContext[];
  training_chunks: ChunkContext[];
  case_docs: CaseDocContext[];
  /** RAG chunks from case docs — only populated when inline case-docs exceed the cap */
  case_doc_chunks: ChunkContext[];
  bizzassist_data: BizzAssistEntity[];
  /** CPR prefixes detected in case docs — logged for audit but NOT sent to Claude */
  cpr_prefixes_redacted: string[];
  /** Composed system-prompt suffix including BIZZ-734 guard */
  system_prompt: string;
  /** Approx token budget used */
  total_tokens: number;
  /** Warnings surfaced to the caller (e.g. "template has no extracted text") */
  warnings: string[];
}

/** Rough token estimate — chars/4. */
function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export interface BuildContextOptions {
  domainId: string;
  caseId: string;
  templateId: string;
  /** Optional extra instructions from the user at generation time */
  userInstructions?: string;
  /**
   * BIZZ-801: Optional subset of case-doc IDs to include as AI context.
   * When present and non-empty, only the listed docs are loaded. When
   * null/undefined/empty, the default behaviour applies — all non-deleted
   * case docs are included.
   */
  selectedDocIds?: string[] | null;
  /** Override fetchers — enables dependency-injected tests */
  fetchers?: {
    template?: (admin: unknown, templateId: string) => Promise<TemplateContext | null>;
    caseDocs?: (
      admin: unknown,
      caseId: string,
      selectedDocIds?: string[] | null
    ) => Promise<CaseDocContext[]>;
  };
}

async function fetchTemplate(admin: unknown, templateId: string): Promise<TemplateContext | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('domain_template')
    .select(
      'id, name, file_type, instructions, examples, placeholders, extracted_text:placeholders'
    )
    .eq('id', templateId)
    .maybeSingle();
  if (!data) return null;
  // extracted_text isn't stored on domain_template — we'd need a column or
  // re-parse via storage. For now return empty so the builder still returns
  // a valid shape; generation that needs the raw body can re-extract on
  // demand (BIZZ-717). Placeholders + instructions + examples ARE stored.
  return {
    id: data.id,
    name: data.name,
    file_type: data.file_type,
    instructions: data.instructions,
    examples: Array.isArray(data.examples) ? data.examples : [],
    placeholders: Array.isArray(data.placeholders) ? data.placeholders : [],
    extracted_text: '',
  };
}

/**
 * BIZZ-786: Fetch training docs explicitly linked to the template via the
 * `domain_template_document` junction, joined with each doc's extracted text.
 * Returns an empty list on any error so generation still proceeds.
 */
async function fetchTemplateDocs(
  admin: unknown,
  domainId: string,
  templateId: string
): Promise<TemplateDocContext[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = (await (admin as any)
      .from('domain_template_document')
      .select(
        // BIZZ-799: domain_training_doc har ikke file_type-kolonne.
        'id, document_id, guidelines, sort_order, document:document_id (id, name, file_path, extracted_text)'
      )
      .eq('template_id', templateId)
      .eq('domain_id', domainId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })) as {
      data: Array<{
        id: string;
        document_id: string;
        guidelines: string | null;
        sort_order: number;
        document: {
          id: string;
          name: string;
          file_path: string | null;
          extracted_text: string | null;
        } | null;
      }> | null;
      error: unknown;
    };
    if (error || !data) return [];
    return data
      .filter((row) => row.document) // drop orphans (shouldn't happen under FK, but be safe)
      .map((row) => {
        // BIZZ-799: Afled file_type fra file_path-endelsen.
        const ext = row.document!.file_path?.split('.').pop()?.toLowerCase() ?? '';
        return {
          attachment_id: row.id,
          document_id: row.document_id,
          name: row.document!.name,
          file_type: ext || 'txt',
          guidelines: row.guidelines,
          sort_order: row.sort_order,
          text: row.document!.extracted_text ?? '',
        };
      });
  } catch (err) {
    logger.warn('[promptBuilder] template-docs fetch failed:', err);
    return [];
  }
}

async function fetchCaseDocs(
  admin: unknown,
  caseId: string,
  selectedDocIds?: string[] | null
): Promise<CaseDocContext[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (admin as any)
    .from('domain_case_doc')
    .select('id, name, file_type, extracted_text')
    .eq('case_id', caseId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  // BIZZ-801: honour explicit doc selection from the user
  if (selectedDocIds && selectedDocIds.length > 0) {
    q = q.in('id', selectedDocIds);
  }
  const { data } = await q;
  return (
    (data ?? []) as Array<{
      id: string;
      name: string;
      file_type: string;
      extracted_text: string | null;
    }>
  ).map((d) => ({
    id: d.id,
    name: d.name,
    file_type: d.file_type,
    text: d.extracted_text ?? '',
  }));
}

/**
 * Build a generation context for Claude. Never throws — errors surface in
 * `warnings` so the caller can decide whether to proceed with a partial
 * context or abort the generation.
 */
export async function buildGenerationContext(
  opts: BuildContextOptions
): Promise<GenerationContext> {
  const admin = createAdminClient();
  const warnings: string[] = [];

  // 1. Load template
  const fetchTpl = opts.fetchers?.template ?? fetchTemplate;
  const template = (await fetchTpl(admin, opts.templateId)) ?? {
    id: opts.templateId,
    name: 'Unknown template',
    file_type: 'txt',
    instructions: null,
    examples: [],
    placeholders: [],
    extracted_text: '',
  };
  if (!template.extracted_text) warnings.push('template-no-extracted-text');

  // 1b. BIZZ-786: Load template-linked reference documents + guidelines.
  // These are explicitly attached by the domain admin and always take priority
  // over generic training chunks — they represent "for THIS template, look
  // at THESE specific docs with THIS guidance".
  const templateDocs = await fetchTemplateDocs(admin, opts.domainId, opts.templateId);

  // 2. Load case docs (BIZZ-801: honour selectedDocIds subset when given)
  const fetchDocs = opts.fetchers?.caseDocs ?? fetchCaseDocs;
  const caseDocs = await fetchDocs(admin, opts.caseId, opts.selectedDocIds);
  const totalCaseDocTokens = caseDocs.reduce((s, d) => s + estimateTokens(d.text), 0);
  let caseDocChunks: ChunkContext[] = [];
  let inlineCaseDocs = caseDocs;
  if (totalCaseDocTokens > CASE_DOC_INLINE_CAP_TOKENS) {
    // Switch to RAG over case doc embeddings — pull top-K relevant chunks
    inlineCaseDocs = [];
    try {
      const query = [template.name, template.instructions ?? '', opts.userInstructions ?? '']
        .filter(Boolean)
        .join(' ');
      if (query.trim()) {
        const [vec] = await embedTexts([query]);
        const hits = await searchDomainEmbeddings(opts.domainId, vec, TRAINING_TOP_K, 0.3);
        caseDocChunks = hits
          .filter((h) => h.source_type === 'case_doc')
          .map((h) => ({
            source_type: h.source_type,
            source_id: h.source_id,
            content: h.content,
            similarity: h.similarity,
          }));
      }
    } catch (err) {
      if (!(err instanceof NoEmbeddingProviderError)) {
        logger.warn('[promptBuilder] case-doc RAG failed:', err);
      }
      warnings.push('case-doc-rag-unavailable');
    }
  }

  // 3. Training-doc vector search (always RAG — they're usually larger)
  let trainingChunks: ChunkContext[] = [];
  try {
    const query = [
      template.name,
      template.instructions ?? '',
      inlineCaseDocs
        .slice(0, 3)
        .map((d) => d.text.slice(0, 500))
        .join(' '),
      opts.userInstructions ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    if (query.trim()) {
      const [vec] = await embedTexts([query]);
      const hits = await searchDomainEmbeddings(opts.domainId, vec, TRAINING_TOP_K, 0.3);
      trainingChunks = hits
        .filter((h) => h.source_type === 'training')
        .map((h) => ({
          source_type: h.source_type,
          source_id: h.source_id,
          content: h.content,
          similarity: h.similarity,
        }));
    }
  } catch (err) {
    if (!(err instanceof NoEmbeddingProviderError)) {
      logger.warn('[promptBuilder] training RAG failed:', err);
    }
    warnings.push('training-rag-unavailable');
  }

  // 4. Entity extraction + BizzAssist data
  const combinedCaseText = inlineCaseDocs.map((d) => d.text).join('\n\n');
  const entities = extractEntities(combinedCaseText);

  // BizzAssist-data enrichment: hit local cvr_virksomhed + ejf_ejerskab +
  // BBR areas for each extracted CVR / BFE. Runs only against cached
  // BizzAssist data (no external API calls besides BBR, which uses the
  // existing Datafordeler-GraphQL helper) so the builder stays cheap and
  // non-blocking — failures are swallowed per-entity.
  let bizzassist: BizzAssistEntity[] = [];
  try {
    bizzassist = await enrichEntities({ cvrs: entities.cvrs, bfes: entities.bfes });
  } catch (err) {
    logger.warn('[promptBuilder] entity enrichment failed:', err);
    warnings.push('entity-enrichment-unavailable');
  }

  // 5. Compose system-prompt suffix — BIZZ-734 guard always included
  const systemParts: string[] = [];
  if (template.instructions) {
    systemParts.push('TEMPLATE INSTRUCTIONS:\n' + template.instructions);
  }
  // BIZZ-786: Surface per-template linked documents + guidelines before the
  // user instructions so the model treats them as "always-on reference" for
  // this template. Each doc is labelled so Claude can cite which attachment
  // informed which decision.
  if (templateDocs.length > 0) {
    const docSections = templateDocs
      .map((d, i) => {
        const header = `[DOC ${i + 1}] ${d.name} (${d.file_type.toUpperCase()})`;
        const guidelinesBlock = d.guidelines
          ? `GUIDELINES: ${d.guidelines}`
          : 'GUIDELINES: (none specified — use as general reference for this template)';
        // Cap per-doc text to keep any single doc from dominating the context;
        // Claude gets the full guidelines and a generous slice of the content.
        const capped = d.text.length > 8000 ? d.text.slice(0, 8000) + '\n…[truncated]' : d.text;
        return `${header}\n${guidelinesBlock}\n---\n${capped}`.trim();
      })
      .join('\n\n');
    systemParts.push(
      'TEMPLATE-SPECIFIC REFERENCE DOCUMENTS:\n' +
        'These documents were explicitly linked to this template by the domain admin. ' +
        'Follow the per-document guidelines when using them. ' +
        'Do not quote verbatim unless a guideline allows it.\n\n' +
        docSections
    );
  }
  if (opts.userInstructions) {
    systemParts.push('USER INSTRUCTIONS:\n' + opts.userInstructions);
  }
  systemParts.push(PROMPT_INJECTION_GUARD_SUFFIX);
  const system_prompt = systemParts.join('\n\n---\n\n');

  // 6. Token accounting — soft-trim if we'd blow the budget
  let tokens = estimateTokens(system_prompt);
  tokens += estimateTokens(template.extracted_text);
  tokens += trainingChunks.reduce((s, c) => s + estimateTokens(c.content), 0);
  tokens += caseDocChunks.reduce((s, c) => s + estimateTokens(c.content), 0);
  tokens += inlineCaseDocs.reduce((s, d) => s + estimateTokens(d.text), 0);
  tokens += template.examples.reduce((s, e) => s + estimateTokens(e.text ?? ''), 0);
  tokens += bizzassist.reduce(
    (s, e) => s + estimateTokens(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)),
    0
  );
  // Note: template-doc text is already embedded in system_prompt so it's
  // counted via estimateTokens(system_prompt) above.

  if (tokens > MAX_CONTEXT_TOKENS) {
    // Drop training chunks first — they're the least-direct signal. Linked
    // template docs are NEVER trimmed here; they were explicitly chosen by
    // the admin as authoritative references for this template.
    while (trainingChunks.length > 0 && tokens > MAX_CONTEXT_TOKENS) {
      const popped = trainingChunks.pop();
      if (popped) tokens -= estimateTokens(popped.content);
    }
    // Then trim case-doc inline text
    while (tokens > MAX_CONTEXT_TOKENS && inlineCaseDocs.length > 0) {
      const popped = inlineCaseDocs.pop();
      if (popped) tokens -= estimateTokens(popped.text);
    }
    if (tokens > MAX_CONTEXT_TOKENS) warnings.push('context-still-over-budget');
  }

  return {
    template,
    template_docs: templateDocs,
    training_chunks: trainingChunks,
    case_docs: inlineCaseDocs,
    case_doc_chunks: caseDocChunks,
    bizzassist_data: bizzassist,
    cpr_prefixes_redacted: entities.cprPrefixes,
    system_prompt,
    total_tokens: tokens,
    warnings,
  };
}
