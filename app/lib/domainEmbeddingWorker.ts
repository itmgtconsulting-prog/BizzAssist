/**
 * BIZZ-715: Domain embedding worker — chunk + embed + persist.
 *
 * Called from upload routes after text extraction. For a given source
 * (template / training_doc / case_doc), it:
 *   1. Chunks the text via domainChunker
 *   2. Looks up existing domain_embedding rows for this source
 *   3. Compares chunk hashes — skips unchanged, embeds new/changed
 *   4. Deletes rows for chunks that are no longer present
 *   5. Inserts new vectors via the mandatory-domain-id insertDomainEmbedding
 *      helper (BIZZ-722 Lag 6 enforcement)
 *
 * Non-fatal: if no embedding provider is configured, skip silently and
 * return { skipped: true }. Callers audit-log the skip so operators can
 * see which uploads didn't produce RAG context.
 *
 * @module app/lib/domainEmbeddingWorker
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { chunkText } from '@/app/lib/domainChunker';
import { embedTexts, NoEmbeddingProviderError } from '@/app/lib/domainEmbed';
import { insertDomainEmbedding, deleteDomainEmbeddings } from '@/app/lib/domainEmbedding';
import { logger } from '@/app/lib/logger';

export type DomainEmbeddingSourceType = 'template' | 'training' | 'case_doc';

export interface EmbeddingWorkerResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  chunksEmbedded?: number;
  chunksSkipped?: number;
  chunksDeleted?: number;
}

/**
 * Embed (or re-embed) a single domain source. Hash-based incremental:
 * only chunks whose hash differs from the existing embedding row get
 * re-embedded. Safe to call repeatedly — idempotent.
 *
 * @param domainId - Domain UUID (must be validated by caller)
 * @param sourceType - template | training_doc | case_doc
 * @param sourceId - UUID of the source row
 * @param text - Extracted plain text (from BIZZ-714)
 */
export async function embedDomainSource(
  domainId: string,
  sourceType: DomainEmbeddingSourceType,
  sourceId: string,
  text: string
): Promise<EmbeddingWorkerResult> {
  if (!text || text.trim().length === 0) {
    return { ok: true, skipped: true, reason: 'empty-text', chunksEmbedded: 0 };
  }

  const chunks = await chunkText(text);
  if (chunks.length === 0) {
    return { ok: true, skipped: true, reason: 'no-chunks', chunksEmbedded: 0 };
  }

  const admin = createAdminClient();

  // Fetch existing embeddings for this source so we can do hash-diff
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (admin as any)
    .from('domain_embedding')
    .select('id, chunk_index, metadata')
    .eq('domain_id', domainId)
    .eq('source_type', sourceType)
    .eq('source_id', sourceId);

  type ExistingRow = { id: string; chunk_index: number; metadata: { hash?: string } | null };
  const existingByIndex = new Map<number, ExistingRow>(
    ((existing ?? []) as ExistingRow[]).map((r) => [r.chunk_index, r])
  );

  // Figure out which chunks need (re-)embedding
  const toEmbed: Array<{ chunk: (typeof chunks)[number]; idx: number }> = [];
  for (const chunk of chunks) {
    const prev = existingByIndex.get(chunk.index);
    if (!prev || prev.metadata?.hash !== chunk.hash) {
      toEmbed.push({ chunk, idx: chunk.index });
    }
  }

  // Delete rows for indices that no longer exist OR whose hash changed
  const validIndices = new Set(chunks.map((c) => c.index));
  const rowsToDelete: string[] = [];
  for (const [idx, row] of existingByIndex) {
    if (!validIndices.has(idx)) rowsToDelete.push(row.id);
  }
  for (const item of toEmbed) {
    const prev = existingByIndex.get(item.idx);
    if (prev) rowsToDelete.push(prev.id);
  }

  if (rowsToDelete.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('domain_embedding').delete().in('id', rowsToDelete);
  }

  // Embed the chunks that need it
  let embeddedCount = 0;
  if (toEmbed.length > 0) {
    try {
      const vectors = await embedTexts(toEmbed.map((t) => t.chunk.text));
      for (let i = 0; i < toEmbed.length; i++) {
        const c = toEmbed[i].chunk;
        await insertDomainEmbedding(domainId, sourceType, sourceId, c.text, vectors[i], {
          hash: c.hash,
          chunk_index: c.index,
          start_offset: c.startOffset,
        });
        embeddedCount++;
      }
    } catch (err) {
      if (err instanceof NoEmbeddingProviderError) {
        logger.warn('[domain/embed] No provider configured — skipping embedding');
        return {
          ok: true,
          skipped: true,
          reason: 'no-provider',
          chunksEmbedded: 0,
          chunksDeleted: rowsToDelete.length,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[domain/embed] Embedding call failed:', msg);
      return { ok: false, reason: msg, chunksEmbedded: embeddedCount };
    }
  }

  return {
    ok: true,
    chunksEmbedded: embeddedCount,
    chunksSkipped: chunks.length - toEmbed.length,
    chunksDeleted: rowsToDelete.length,
  };
}

/**
 * Convenience: fetch the current extracted_text for a source and run
 * embedDomainSource against it. Used by callers that don't already have
 * the text in hand.
 */
export async function embedDomainSourceById(
  domainId: string,
  sourceType: DomainEmbeddingSourceType,
  sourceId: string
): Promise<EmbeddingWorkerResult> {
  const admin = createAdminClient();
  const table =
    sourceType === 'template'
      ? 'domain_template'
      : sourceType === 'training'
        ? 'domain_training_doc'
        : 'domain_case_doc';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from(table)
    .select('extracted_text')
    .eq('id', sourceId)
    .maybeSingle();
  const text = (data as { extracted_text?: string } | null)?.extracted_text ?? '';
  if (!text) {
    return { ok: true, skipped: true, reason: 'no-extracted-text', chunksEmbedded: 0 };
  }
  return embedDomainSource(domainId, sourceType, sourceId, text);
}

/**
 * Remove all embeddings for a source (called when the source is hard-deleted).
 */
export async function removeDomainSourceEmbeddings(
  domainId: string,
  sourceType: DomainEmbeddingSourceType,
  sourceId: string
): Promise<void> {
  await deleteDomainEmbeddings(domainId, sourceType, sourceId);
}
