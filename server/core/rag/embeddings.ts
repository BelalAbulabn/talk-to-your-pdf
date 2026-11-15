import { config } from '../config';
import { openaiPost } from '../openai';
import { embeddingCostUsd } from '../pricing';
import { usage } from '../usage';

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
  usage?: { prompt_tokens?: number };
}

const BATCH_SIZE = 100;

/** Identifies the vector space; stored with each document and checked on search. */
export function embeddingModelId(): string {
  const cfg = config();
  return `${cfg.embeddingModel}:${cfg.embeddingDimensions}`;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const cfg = config();
  const vectors: number[][] = [];
  let tokens = 0;
  try {
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const response = await openaiPost<EmbeddingResponse>('/embeddings', {
        model: cfg.embeddingModel,
        input: texts.slice(i, i + BATCH_SIZE),
        dimensions: cfg.embeddingDimensions,
      });
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      // 6 decimals is plenty for ranking and keeps the JSON index small.
      vectors.push(
        ...ordered.map((d) =>
          d.embedding.map((v) => Math.round(v * 1e6) / 1e6),
        ),
      );
      tokens += response.usage?.prompt_tokens ?? 0;
    }
  } finally {
    usage().addSpend(embeddingCostUsd(tokens));
  }
  return vectors;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector;
}
