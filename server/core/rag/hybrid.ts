const TOKEN = /[\p{L}\p{N}]+/gu;

/** Lower-cased words and numbers; single letters are dropped, single digits kept. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN) ?? []).filter(
    (token) => token.length > 1 || /\d/.test(token),
  );
}

/** Okapi BM25 keyword relevance of each document for the query. */
export function bm25Scores(
  query: string[],
  documents: string[][],
  k1 = 1.2,
  b = 0.75,
): number[] {
  const count = documents.length;
  const terms = [...new Set(query)];
  if (count === 0 || terms.length === 0) return new Array(count).fill(0);

  const averageLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) / count || 1;
  const frequencies = documents.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    return tf;
  });
  const idf = new Map<string, number>();
  for (const term of terms) {
    const withTerm = frequencies.filter((tf) => tf.has(term)).length;
    idf.set(term, Math.log(1 + (count - withTerm + 0.5) / (withTerm + 0.5)));
  }

  return frequencies.map((tf, i) => {
    const lengthNorm = 1 - b + (b * documents[i].length) / averageLength;
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f > 0)
        score +=
          (idf.get(term) ?? 0) * ((f * (k1 + 1)) / (f + k1 * lengthNorm));
    }
    return score;
  });
}

/**
 * Reciprocal Rank Fusion: merges several rankings (lists of item indexes, best
 * first) into one score per item. Robust because it only uses ranks, not raw scores.
 */
export function reciprocalRankFusion(
  rankings: number[][],
  k = 60,
): Map<number, number> {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((item, rank) => {
      fused.set(item, (fused.get(item) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}
