import { describe, expect, it } from 'vitest';
import { chunkPages } from './chunk';

const sentence = (i: number) =>
  `Sentence number ${i} explains one specific detail of the contract.`;

describe('chunkPages', () => {
  it('keeps every page in its own chunk, even when pages are short', () => {
    expect(chunkPages(['  Hello\n\nworld.  ', '', 'Page three.'])).toEqual([
      { page: 1, pageEnd: 1, text: 'Hello world.' },
      { page: 3, pageEnd: 3, text: 'Page three.' },
    ]);
  });

  it('cuts only at sentence boundaries and repeats the last sentence as overlap', () => {
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkPages([text], 400, 120);

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400);
      expect(chunk.text).toMatch(/^Sentence number \d+/);
      expect(chunk.text).toMatch(/contract\.$/);
    }
    const lastOfFirst = chunks[0].text.split(/(?<=\.) /).pop()!;
    expect(chunks[1].text.startsWith(lastOfFirst)).toBe(true);
    expect(chunks.at(-1)!.text.endsWith(sentence(39))).toBe(true);
  });

  it('never lets a chunk cross a page break', () => {
    const page = Array.from({ length: 12 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkPages([page, page, page], 500, 100);

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.pageEnd).toBe(chunk.page);
    expect(chunks[0].page).toBe(1);
    expect(chunks.at(-1)!.page).toBe(3);
    // the overlap of the first chunk on page 2 does not come from page 1
    const firstOnPage2 = chunks.find((c) => c.page === 2)!;
    expect(firstOnPage2.text.startsWith(sentence(0))).toBe(true);
  });

  it('falls back to word boundaries for very long sentences', () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkPages([words], 500, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(500);
      expect(chunk.text).toMatch(/^word\d+/);
    }
    expect(chunks.at(-1)!.text.endsWith('word299')).toBe(true);
  });

  it('always makes progress on text without spaces', () => {
    const chunks = chunkPages(['x'.repeat(2500)], 1000, 200);
    expect(chunks.map((c) => c.text.length)).toEqual([1000, 1000, 500]);
  });
});
