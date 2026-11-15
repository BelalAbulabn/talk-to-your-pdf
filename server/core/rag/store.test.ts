import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocStore, type StoredDoc } from './store';

const VISITOR_A = '0b6a8f5e-1c1d-4e8a-9b1f-2a3b4c5d6e7f';
const VISITOR_B = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
const MODEL = 'text-embedding-3-small:3';
const TTL = 60_000;

function doc(
  id: string,
  name: string,
  embedding: number[],
  createdAt: number,
): StoredDoc {
  return {
    id,
    name,
    pages: 1,
    sizeBytes: 100,
    createdAt,
    embeddingModel: MODEL,
    chunks: [{ page: 1, text: `${name} text`, embedding }],
  };
}

describe('DocStore', () => {
  let root: string;
  let now: number;
  let store: DocStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
    now = 1_000_000;
    store = new DocStore(root, TTL, () => now);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ranks chunks by cosine similarity', async () => {
    await store.add(VISITOR_A, doc('a'.repeat(24), 'apples', [1, 0, 0], now));
    await store.add(VISITOR_A, doc('b'.repeat(24), 'bananas', [0, 1, 0], now));

    const hits = await store.search(
      VISITOR_A,
      'fruit',
      [0.1, 0.9, 0],
      MODEL,
      5,
    );
    expect(hits.map((h) => h.document)).toEqual(['bananas', 'apples']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('finds exact codes by keyword even when the vectors disagree', async () => {
    const coded = doc('c'.repeat(24), 'orders', [0, 0, 1], now);
    coded.chunks = [
      {
        page: 2,
        pageEnd: 3,
        text: 'Order 4711 ships in May.',
        embedding: [0, 0, 1],
      },
      { page: 4, text: 'General shipping terms.', embedding: [1, 0, 0] },
      { page: 5, text: 'Returns are free.', embedding: [0.9, 0.1, 0] },
    ];
    await store.add(VISITOR_A, coded);

    // The query vector is closest to the unrelated chunks; BM25 lifts the exact match.
    const hits = await store.search(
      VISITOR_A,
      'order 4711',
      [1, 0, 0],
      MODEL,
      1,
    );
    expect(hits[0].text).toBe('Order 4711 ships in May.');
    expect(hits[0]).toMatchObject({ page: 2, pageEnd: 3 });
  });

  it('keeps visitors isolated', async () => {
    await store.add(VISITOR_A, doc('a'.repeat(24), 'secret', [1, 0, 0], now));
    expect(await store.list(VISITOR_B)).toEqual([]);
    expect(
      await store.search(VISITOR_B, 'secret', [1, 0, 0], MODEL, 5),
    ).toEqual([]);
  });

  it('skips documents embedded with a different model', async () => {
    await store.add(VISITOR_A, doc('a'.repeat(24), 'old', [1, 0, 0], now));
    expect(
      await store.search(VISITOR_A, 'old', [1, 0, 0], 'other-model:3', 5),
    ).toEqual([]);
  });

  it('expires documents after the TTL', async () => {
    await store.add(VISITOR_A, doc('a'.repeat(24), 'old', [1, 0, 0], now));
    expect(await store.list(VISITOR_A)).toHaveLength(1);

    now += TTL;
    expect(await store.list(VISITOR_A)).toEqual([]);
  });

  it('removes documents and rejects path traversal ids', async () => {
    await store.add(VISITOR_A, doc('a'.repeat(24), 'one', [1, 0, 0], now));
    expect(await store.remove(VISITOR_A, '../../etc/passwd')).toBe(false);
    expect(await store.remove(VISITOR_A, 'a'.repeat(24))).toBe(true);
    expect(await store.list(VISITOR_A)).toEqual([]);
    await expect(store.list('../escape')).rejects.toThrow('invalid visitor id');
  });
});
