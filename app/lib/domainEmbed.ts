/**
 * BIZZ-715: Embedding client for domain RAG.
 *
 * Calls the configured embedding provider (OpenAI or Voyage) via HTTPS.
 * Returns a 1536-dim float array matching the domain_embedding.embedding
 * pgvector column shape.
 *
 * Provider precedence:
 *   1. OPENAI_API_KEY → OpenAI text-embedding-3-small (1536 dim)
 *   2. VOYAGE_API_KEY → Voyage voyage-3-lite (1024 dim → padded to 1536)
 *   3. (missing keys)  → NoProviderError so callers can audit-skip rather
 *      than store garbage vectors
 *
 * @module app/lib/domainEmbed
 */

export const EMBEDDING_DIMENSIONS = 1536;

export class NoEmbeddingProviderError extends Error {
  constructor() {
    super('No embedding provider configured (set OPENAI_API_KEY or VOYAGE_API_KEY)');
    this.name = 'NoEmbeddingProviderError';
  }
}

/**
 * Pad a shorter embedding with zeros to match our pgvector(1536) column.
 * Used when a provider returns a different dimensionality — we keep the
 * storage column fixed for simplicity.
 */
function padTo1536(v: number[]): number[] {
  if (v.length === EMBEDDING_DIMENSIONS) return v;
  if (v.length > EMBEDDING_DIMENSIONS) return v.slice(0, EMBEDDING_DIMENSIONS);
  const out = v.slice();
  while (out.length < EMBEDDING_DIMENSIONS) out.push(0);
  return out;
}

/**
 * Embed an array of texts. Returns vectors in the same order as input.
 * Batches against the provider's max-batch when possible.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    return embedWithOpenAI(texts, openAiKey);
  }
  const voyageKey = process.env.VOYAGE_API_KEY;
  if (voyageKey) {
    return embedWithVoyage(texts, voyageKey);
  }
  throw new NoEmbeddingProviderError();
}

async function embedWithOpenAI(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };
  // Sort by index to keep alignment with the input order
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => padTo1536(d.embedding));
}

async function embedWithVoyage(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-3-lite',
      input: texts,
      input_type: 'document',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Voyage embeddings failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => padTo1536(d.embedding));
}
