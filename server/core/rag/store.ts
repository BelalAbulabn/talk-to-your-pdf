import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { isUuid } from '../ids';
import { bm25Scores, reciprocalRankFusion, tokenize } from './hybrid';

export interface StoredChunk {
  page: number;
  /** Missing in documents indexed before chunks could span pages. */
  pageEnd?: number;
  text: string;
  embedding: number[];
}

export interface StoredDoc {
  id: string;
  name: string;
  pages: number;
  sizeBytes: number;
  createdAt: number;
  /** "<model>:<dimensions>" — vectors from different models can't be compared. */
  embeddingModel: string;
  chunks: StoredChunk[];
}

export interface DocSummary {
  id: string;
  name: string;
  pages: number;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
}

export interface SearchHit {
  document: string;
  page: number;
  pageEnd: number;
  text: string;
  score: number;
}

const DOC_ID_RE = /^[0-9a-f]{24}$/;
const CACHE_IDLE_MS = 15 * 60 * 1000;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Per-visitor document index on disk: <root>/visitors/<visitorId>/<docId>.json */
export class DocStore {
  private readonly cache = new Map<
    string,
    { docs: StoredDoc[]; touched: number }
  >();
  /** Tokenized chunk texts for keyword search, computed once per loaded document. */
  private readonly tokens = new WeakMap<StoredDoc, string[][]>();

  constructor(
    private readonly root: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  newDocId(): string {
    return crypto.randomBytes(12).toString('hex');
  }

  async list(visitorId: string): Promise<DocSummary[]> {
    const docs = await this.load(visitorId);
    return docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      pages: doc.pages,
      sizeBytes: doc.sizeBytes,
      createdAt: doc.createdAt,
      expiresAt: doc.createdAt + this.ttlMs,
    }));
  }

  async add(visitorId: string, doc: StoredDoc): Promise<void> {
    if (!DOC_ID_RE.test(doc.id)) throw new Error('invalid document id');
    const dir = this.visitorDir(visitorId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${doc.id}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(doc));
    await fs.rename(`${file}.tmp`, file);
    this.cache.delete(visitorId);
  }

  async remove(visitorId: string, docId: string): Promise<boolean> {
    if (!DOC_ID_RE.test(docId)) return false;
    this.cache.delete(visitorId);
    try {
      await fs.unlink(path.join(this.visitorDir(visitorId), `${docId}.json`));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /**
   * Hybrid search: ranks chunks by vector similarity (meaning) and by BM25
   * (exact words, numbers, codes) and merges both rankings with RRF.
   */
  async search(
    visitorId: string,
    queryText: string,
    queryVector: number[],
    embeddingModel: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const docs = (await this.load(visitorId)).filter(
      (doc) => doc.embeddingModel === embeddingModel,
    );
    const candidates: {
      doc: StoredDoc;
      chunk: StoredChunk;
      tokens: string[];
    }[] = [];
    for (const doc of docs) {
      const docTokens = this.chunkTokens(doc);
      doc.chunks.forEach((chunk, i) => {
        candidates.push({ doc, chunk, tokens: docTokens[i] });
      });
    }
    if (candidates.length === 0) return [];

    const byIndexDesc = (scores: number[]) =>
      scores
        .map((score, index) => ({ score, index }))
        .sort((a, b) => b.score - a.score);

    const vectorRanking = byIndexDesc(
      candidates.map((c) => cosine(queryVector, c.chunk.embedding)),
    ).map((entry) => entry.index);
    const keywordRanking = byIndexDesc(
      bm25Scores(
        tokenize(queryText),
        candidates.map((c) => c.tokens),
      ),
    )
      .filter((entry) => entry.score > 0)
      .map((entry) => entry.index);

    const fused = reciprocalRankFusion([vectorRanking, keywordRanking]);
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([index, score]) => {
        const { doc, chunk } = candidates[index];
        return {
          document: doc.name,
          page: chunk.page,
          pageEnd: chunk.pageEnd ?? chunk.page,
          text: chunk.text,
          score,
        };
      });
  }

  private chunkTokens(doc: StoredDoc): string[][] {
    let cached = this.tokens.get(doc);
    if (!cached) {
      cached = doc.chunks.map((chunk) => tokenize(chunk.text));
      this.tokens.set(doc, cached);
    }
    return cached;
  }

  /** Deletes expired documents and empty visitor folders. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [visitorId, entry] of this.cache) {
      if (now - entry.touched > CACHE_IDLE_MS) this.cache.delete(visitorId);
    }
    const visitorsDir = path.join(this.root, 'visitors');
    let visitors: string[];
    try {
      visitors = await fs.readdir(visitorsDir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const visitorId of visitors) {
      if (!isUuid(visitorId)) continue;
      const dir = path.join(visitorsDir, visitorId);
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      let remaining = 0;
      for (const name of files) {
        const file = path.join(dir, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat && stat.mtimeMs + this.ttlMs <= now) {
          await fs.unlink(file).catch(() => undefined);
          this.cache.delete(visitorId);
        } else if (stat) {
          remaining++;
        }
      }
      if (remaining === 0) {
        await fs.rmdir(dir).catch(() => undefined);
      }
    }
  }

  private visitorDir(visitorId: string): string {
    if (!isUuid(visitorId)) throw new Error('invalid visitor id');
    return path.join(this.root, 'visitors', visitorId);
  }

  private async load(visitorId: string): Promise<StoredDoc[]> {
    const now = this.now();
    let entry = this.cache.get(visitorId);
    if (!entry) {
      entry = { docs: await this.readAll(visitorId), touched: now };
      this.cache.set(visitorId, entry);
    }
    entry.touched = now;

    const expired = entry.docs.filter((d) => d.createdAt + this.ttlMs <= now);
    if (expired.length > 0) {
      for (const doc of expired) await this.remove(visitorId, doc.id);
      entry = {
        docs: entry.docs.filter((d) => !expired.includes(d)),
        touched: now,
      };
      this.cache.set(visitorId, entry);
    }
    return entry.docs;
  }

  private async readAll(visitorId: string): Promise<StoredDoc[]> {
    const dir = this.visitorDir(visitorId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const docs: StoredDoc[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        docs.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
      } catch (error) {
        console.warn(`[store] skipping unreadable document ${name}`, error);
      }
    }
    return docs.sort((a, b) => a.createdAt - b.createdAt);
  }
}

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const globalState = globalThis as typeof globalThis & { __vcpStore?: DocStore };

export function docStore(): DocStore {
  if (!globalState.__vcpStore) {
    const cfg = config();
    const store = new DocStore(cfg.storageDir, cfg.limits.docTtlMs);
    const sweep = () =>
      store.sweep().catch((e) => console.error('[store] sweep failed', e));
    sweep();
    setInterval(sweep, SWEEP_INTERVAL_MS).unref();
    globalState.__vcpStore = store;
  }
  return globalState.__vcpStore;
}
