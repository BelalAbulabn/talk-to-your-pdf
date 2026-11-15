import { config } from '../config';
import { ApiError } from '../errors';
import { chunkPages } from './chunk';
import { embeddingModelId, embedTexts } from './embeddings';
import { readPdfPages } from './pdf';
import { docStore, type DocSummary } from './store';

const inFlight = new Set<string>();

export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 120) || 'document.pdf';
}

export async function ingestPdf(
  visitorId: string,
  fileName: string,
  data: Uint8Array,
): Promise<DocSummary> {
  const { limits } = config();
  const store = docStore();
  if (inFlight.has(visitorId)) {
    throw new ApiError(
      'upload_in_progress',
      'Another upload is still being processed.',
    );
  }
  inFlight.add(visitorId);
  try {
    const existing = await store.list(visitorId);
    if (existing.length >= limits.maxDocsPerVisitor) {
      throw new ApiError(
        'file_limit',
        `You can keep up to ${limits.maxDocsPerVisitor} documents. Delete one first.`,
      );
    }
    const sizeBytes = data.byteLength;
    const pages = await readPdfPages(data, limits.maxPdfPages);
    const chunks = chunkPages(pages);
    if (chunks.length === 0) {
      throw new ApiError(
        'no_text_found',
        'No text found in this PDF. Scanned PDFs (images only) are not supported.',
      );
    }
    const name = cleanFileName(fileName);
    // Contextual header: the document name is embedded with every chunk.
    const vectors = await embedTexts(
      chunks.map((c) => `Document: ${name}\n${c.text}`),
    );
    const createdAt = Date.now();
    const doc = {
      id: store.newDocId(),
      name,
      pages: pages.length,
      sizeBytes,
      createdAt,
      embeddingModel: embeddingModelId(),
      chunks: chunks.map((c, i) => ({ ...c, embedding: vectors[i] })),
    };
    await store.add(visitorId, doc);
    return {
      id: doc.id,
      name: doc.name,
      pages: doc.pages,
      sizeBytes,
      createdAt,
      expiresAt: createdAt + limits.docTtlMs,
    };
  } finally {
    inFlight.delete(visitorId);
  }
}
