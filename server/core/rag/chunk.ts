export interface TextChunk {
  /** First page the chunk covers (1-based). */
  page: number;
  /** Last page the chunk covers. Chunks stay on one page, so this equals `page`. */
  pageEnd: number;
  text: string;
}

interface Unit {
  text: string;
  page: number;
}

// Split after sentence-ending punctuation (Latin, Arabic, CJK) followed by whitespace.
const SENTENCE_BOUNDARY = /(?<=[.!?…؟。])\s+/u;

function joinedLength(units: Unit[]): number {
  return (
    units.reduce((sum, unit) => sum + unit.text.length, 0) +
    Math.max(0, units.length - 1)
  );
}

/** Splits text longer than `max` at word boundaries (or hard-cuts words longer than `max`). */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (word.length > max) {
      if (current) parts.push(current);
      current = '';
      for (let i = 0; i < word.length; i += max)
        parts.push(word.slice(i, i + max));
      continue;
    }
    if (current && current.length + 1 + word.length > max) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Sentence-aware chunking: pages are split into sentences, which are packed into
 * chunks of at most `size` characters. A chunk never crosses a page break, so every
 * answer can cite one exact page. Within a page, each new chunk repeats the last
 * sentences of the previous one (up to `overlap` characters).
 */
export function chunkPages(
  pages: string[],
  size = 1000,
  overlap = 150,
): TextChunk[] {
  const units: Unit[] = [];
  pages.forEach((raw, index) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return;
    for (const sentence of text.split(SENTENCE_BOUNDARY)) {
      for (const piece of splitLong(sentence, size)) {
        units.push({ text: piece, page: index + 1 });
      }
    }
  });

  const chunks: TextChunk[] = [];
  let current: Unit[] = [];
  const flush = () => {
    chunks.push({
      page: current[0].page,
      pageEnd: current[current.length - 1].page,
      text: current.map((unit) => unit.text).join(' '),
    });
  };

  for (const unit of units) {
    if (current.length > 0 && current[0].page !== unit.page) {
      flush();
      current = [];
    } else if (current.length > 0 && joinedLength([...current, unit]) > size) {
      flush();
      const carry: Unit[] = [];
      for (let i = current.length - 1; i >= 0; i--) {
        if (joinedLength([current[i], ...carry]) > overlap) break;
        carry.unshift(current[i]);
      }
      current = carry;
      while (current.length > 0 && joinedLength([...current, unit]) > size) {
        current.shift();
      }
    }
    current.push(unit);
  }
  if (current.length > 0) flush();
  return chunks;
}
