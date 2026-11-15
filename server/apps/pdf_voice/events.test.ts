import { describe, expect, it } from 'vitest';
import { readSse } from './chat';
import { CallEventHub, type CallEvent } from './events';
import { sourcesOf } from './search';

describe('CallEventHub', () => {
  it('replays earlier events to late subscribers, then streams new ones', () => {
    const hub = new CallEventHub();
    hub.publish('c1', { event: 'search', data: { query: 'delivery' } });

    const seen: CallEvent[] = [];
    const unsubscribe = hub.subscribe('c1', (e) => seen.push(e));
    hub.publish('c1', { event: 'ended', data: { reason: 'time_limit' } });
    unsubscribe();
    hub.publish('c1', { event: 'search', data: { query: 'after' } });

    expect(seen.map((e) => e.event)).toEqual(['search', 'ended']);
    expect(hub.hasEnded('c1')).toBe(true);
    expect(hub.hasEnded('c2')).toBe(false);
  });

  it('keeps calls apart', () => {
    const hub = new CallEventHub();
    const seen: string[] = [];
    hub.subscribe('a', (e) => seen.push(`a:${e.event}`));
    hub.publish('b', { event: 'search', data: { query: 'x' } });
    expect(seen).toEqual([]);
  });
});

describe('sourcesOf', () => {
  it('lists each document/page once, in ranking order', () => {
    const hit = (document: string, page: number, pageEnd = page) => ({
      document,
      page,
      pageEnd,
      text: '',
      score: 1,
    });
    expect(
      sourcesOf([hit('a.pdf', 2), hit('b.pdf', 3, 4), hit('a.pdf', 2)]),
    ).toEqual([
      { document: 'a.pdf', page: '2' },
      { document: 'b.pdf', page: '3-4' },
    ]);
  });
});

describe('readSse', () => {
  it('parses events split across chunks and CRLF line endings', async () => {
    const chunks = [
      'event: x\r\ndata: {"type":"response.output_text.delta",',
      '"delta":"Hel"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'data: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const deltas: unknown[] = [];
    for await (const event of readSse(body)) deltas.push(event.delta);
    expect(deltas).toEqual(['Hel', 'lo']);
  });
});
