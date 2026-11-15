import { describe, expect, it } from 'vitest';
import { bm25Scores, reciprocalRankFusion, tokenize } from './hybrid';

describe('tokenize', () => {
  it('keeps words, numbers and codes across scripts', () => {
    expect(
      tokenize('Order Nr. 4711-B, §14a EnWG — Lieferzeit: 5 Tage'),
    ).toEqual([
      'order',
      'nr',
      '4711',
      '14a',
      'enwg',
      'lieferzeit',
      '5',
      'tage',
    ]);
    expect(tokenize('مرحبا بالعالم')).toEqual(['مرحبا', 'بالعالم']);
  });
});

describe('bm25Scores', () => {
  const docs = [
    'the delivery time is five working days',
    'invoice 4711 was paid on time',
    'the warranty covers two years',
  ].map(tokenize);

  it('ranks the document containing an exact code first', () => {
    const scores = bm25Scores(tokenize('invoice 4711'), docs);
    expect(scores[1]).toBeGreaterThan(0);
    expect(scores[0]).toBe(0);
    expect(scores[2]).toBe(0);
  });

  it('weights rare terms higher than common ones', () => {
    const scores = bm25Scores(tokenize('the warranty'), docs);
    expect(scores[2]).toBeGreaterThan(scores[0]);
  });

  it('returns zeros for an empty query', () => {
    expect(bm25Scores([], docs)).toEqual([0, 0, 0]);
  });
});

describe('reciprocalRankFusion', () => {
  it('prefers items ranked well by both lists', () => {
    const fused = reciprocalRankFusion([
      [0, 1, 2],
      [1, 2],
    ]);
    const order = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([i]) => i);
    expect(order).toEqual([1, 2, 0]);
  });
});
