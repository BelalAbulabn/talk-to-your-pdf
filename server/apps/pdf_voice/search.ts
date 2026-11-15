import { embedQuery, embeddingModelId } from '../../core/rag/embeddings';
import { docStore, type SearchHit } from '../../core/rag/store';

export const SEARCH_RESULTS = 5;

export interface Source {
  document: string;
  /** "3", or "3-4" when the passage spans pages */
  page: string;
}

export function pageLabel(hit: Pick<SearchHit, 'page' | 'pageEnd'>): string {
  return hit.pageEnd > hit.page ? `${hit.page}-${hit.pageEnd}` : `${hit.page}`;
}

/** Hybrid (keyword + vector) search over the visitor's own documents. */
export async function searchDocuments(
  visitorId: string,
  query: string,
  limit = SEARCH_RESULTS,
): Promise<SearchHit[]> {
  const text = query.slice(0, 2000);
  const vector = await embedQuery(text);
  return docStore().search(visitorId, text, vector, embeddingModelId(), limit);
}

/** Distinct document/page pairs of the hits, in ranking order. */
export function sourcesOf(hits: SearchHit[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const hit of hits) {
    const source = { document: hit.document, page: pageLabel(hit) };
    const key = `${source.document}\u0000${source.page}`;
    if (!seen.has(key)) {
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}

/** Excerpts as the model sees them: numbered, with document and page. */
export function formatExcerpts(hits: SearchHit[]): string {
  return hits
    .map(
      (hit, i) =>
        `[${i + 1}] ${hit.document}, page ${pageLabel(hit)}:\n${hit.text}`,
    )
    .join('\n\n');
}
