'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Clock, FileText, Search } from 'react-feather';
import type { Speaker, TranscriptItem } from './useRealtimeCall';

interface TranscriptProps {
  items: TranscriptItem[];
  speaker: Speaker;
  endedLabel: string | null;
}

/** Renders the **bold** and *italic* marks that text answers may contain. */
function rich(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

const CITED_PAGE =
  /(?<!\p{L})(?:pages?|seiten?|s\.|p\.|pp\.|صفحة|الصفحة|صفحات|الصفحات)\s*(\d+)(?:\s*(?:-|–|and|und|و)\s*(\d+))?/giu;

/**
 * The search returns several pages; the chip shows only the ones the answer cites,
 * e.g. "(contract.pdf, page 2)". Without a citation it shows the best match.
 */
function citedPages(pages: string, answer: string): string {
  const latin = answer.replace(/[٠-٩]/g, (d) =>
    String(d.charCodeAt(0) - 0x0660),
  );
  const cited = new Set<string>();
  for (const match of latin.matchAll(CITED_PAGE)) {
    cited.add(match[1]);
    if (match[2]) cited.add(match[2]);
  }
  const all = pages.split(', ');
  const kept = all.filter((page) => page.split('-').some((n) => cited.has(n)));
  return (kept.length > 0 ? kept : all.slice(0, 1)).join(', ');
}

export function Transcript({ items, speaker, endedLabel }: TranscriptProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastAssistantId = [...items]
    .reverse()
    .find((item) => item.role === 'assistant')?.id;

  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [items, endedLabel]);

  return (
    <div
      className="transcript"
      ref={ref}
      aria-label="Transcript"
      aria-live="polite"
    >
      {items.map((item) => {
        if (item.role === 'tool') {
          return (
            <div
              key={item.id}
              className={`sys${item.pending ? ' is-active' : ''}`}
            >
              {item.pending ? (
                <span className="spin" aria-hidden="true" />
              ) : (
                <Search aria-hidden="true" />
              )}
              <span>{item.text}</span>
            </div>
          );
        }
        if (item.role === 'user') {
          return (
            <div key={item.id} className="msg msg--user">
              <div
                className={`bubble bubble--user${item.pending ? ' is-live' : ''}`}
              >
                {item.text || '…'}
              </div>
              <span className={`who${item.pending ? ' is-live' : ''}`}>
                {item.pending ? 'You · speaking' : 'You'}
              </span>
            </div>
          );
        }
        const talking = speaker === 'assistant' && item.id === lastAssistantId;
        return (
          <div key={item.id} className="msg msg--asst">
            <div
              className={`avatar${talking ? ' talk' : ''}`}
              aria-hidden="true"
            >
              <i />
              <i />
              <i />
            </div>
            <div className="asst-col">
              <div
                className={`bubble bubble--asst${item.pending ? ' is-streaming' : ''}`}
              >
                {item.text ? rich(item.text) : '…'}
                {item.pending && <span className="caret" aria-hidden="true" />}
              </div>
              {item.source && !item.pending && (
                <span className="source">
                  <FileText aria-hidden="true" />
                  <span>{item.source.document}</span>
                  {item.source.pages && (
                    <b>p. {citedPages(item.source.pages, item.text)}</b>
                  )}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {endedLabel && (
        <div className="sys is-end">
          <Clock aria-hidden="true" />
          <span>{endedLabel}</span>
        </div>
      )}
    </div>
  );
}
