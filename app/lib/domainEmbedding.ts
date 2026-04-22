/**
 * Domain embedding helpers — BIZZ-722 Lag 6.
 *
 * All vector searches against domain_embedding MUST go through this module.
 * Direct supabase.rpc() calls against the embedding table are forbidden
 * (enforced by ESLint rule — see eslint config).
 *
 * This ensures every vector query is filtered by domain_id, preventing
 * cross-domain RAG data leaks.
 *
 * @module app/lib/domainEmbedding
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Embedding search result */
export interface EmbeddingMatch {
  /** Embedding row ID */
  id: string;
  /** Source type: template, training_doc, or case_doc */
  source_type: string;
  /** Source row ID */
  source_id: string;
  /** Text chunk content */
  content: string;
  /** Cosine similarity score (0–1) */
  similarity: number;
}

/**
 * Searches domain embeddings using cosine similarity.
 * ALWAYS filtered by domain_id — no cross-domain results possible.
 *
 * @param domainId - Validated domain UUID (must come from assertDomainMember)
 * @param queryEmbedding - Query vector (1536 dimensions, matching Voyage AI output)
 * @param limit - Maximum number of results (default 10)
 * @param threshold - Minimum similarity threshold (default 0.5)
 * @returns Array of matching embeddings sorted by similarity DESC
 */
export async function searchDomainEmbeddings(
  domainId: string,
  queryEmbedding: number[],
  limit = 10,
  threshold = 0.5
): Promise<EmbeddingMatch[]> {
  const admin = createAdminClient();

  // Use a custom RPC function that enforces domain_id filtering server-side
  const { data, error } = await (admin as SupabaseClient).rpc('match_domain_embeddings', {
    p_domain_id: domainId,
    p_query_embedding: queryEmbedding,
    p_match_count: limit,
    p_match_threshold: threshold,
  });

  if (error) {
    throw new Error(`Embedding-søgning fejlede: ${error.message}`);
  }

  return (data || []) as EmbeddingMatch[];
}

/**
 * Inserts an embedding for a domain document chunk.
 * Domain_id is always included — cannot be omitted.
 *
 * @param domainId - Validated domain UUID
 * @param sourceType - Source type (template, training_doc, case_doc)
 * @param sourceId - Source row UUID
 * @param content - Text chunk content
 * @param embedding - Vector (1536 dimensions)
 * @param metadata - Optional metadata JSON
 * @returns Inserted embedding ID
 */
export async function insertDomainEmbedding(
  domainId: string,
  sourceType: 'template' | 'training' | 'case_doc',
  sourceId: string,
  content: string,
  embedding: number[],
  metadata?: Record<string, unknown>
): Promise<string> {
  const admin = createAdminClient();

  const { data, error } = await (admin as SupabaseClient)
    .from('domain_embedding')
    .insert({
      domain_id: domainId,
      source_type: sourceType,
      source_id: sourceId,
      content,
      embedding,
      metadata: metadata || {},
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Embedding-insert fejlede: ${error.message}`);
  }

  return data.id as string;
}

/**
 * Deletes all embeddings for a given source within a domain.
 * Used when a template/training doc/case doc is deleted or re-processed.
 *
 * @param domainId - Validated domain UUID
 * @param sourceType - Source type
 * @param sourceId - Source row UUID
 */
export async function deleteDomainEmbeddings(
  domainId: string,
  sourceType: string,
  sourceId: string
): Promise<void> {
  const admin = createAdminClient();

  const { error } = await (admin as SupabaseClient)
    .from('domain_embedding')
    .delete()
    .eq('domain_id', domainId)
    .eq('source_type', sourceType)
    .eq('source_id', sourceId);

  if (error) {
    throw new Error(`Embedding-sletning fejlede: ${error.message}`);
  }
}
