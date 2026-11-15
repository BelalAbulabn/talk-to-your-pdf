'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ApiFailure,
  streamChat,
  type ChatMessage,
  type Source,
} from '@/lib/api';
import { toSourceRef, type TranscriptItem } from './useRealtimeCall';

/** Typed questions answered by POST /v1/pdf/chat (no microphone, no call needed). */
export function useTextChat(onAnswered?: () => void) {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef<TranscriptItem[]>([]);
  itemsRef.current = items;

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;
      const history: ChatMessage[] = itemsRef.current
        .filter((i) => i.role !== 'tool' && !i.pending && i.text)
        .slice(-10)
        .map((i) => ({ role: i.role as ChatMessage['role'], content: i.text }));

      const stamp = Date.now();
      const ids = {
        user: `t${stamp}u`,
        search: `t${stamp}s`,
        answer: `t${stamp}a`,
      };
      setItems((prev) => [
        ...prev,
        {
          id: ids.user,
          role: 'user',
          text: question,
          pending: false,
          createdAt: stamp,
        },
      ]);
      setBusy(true);
      setError(null);

      const sources: Source[] = [];
      const update = (
        id: string,
        change: (item: TranscriptItem) => TranscriptItem,
      ) =>
        setItems((prev) =>
          prev.map((item) => (item.id === id ? change(item) : item)),
        );

      try {
        await streamChat(question, history, (event, data) => {
          if (event === 'search') {
            const query = (data as { query?: string }).query ?? '';
            setItems((prev) => [
              ...prev,
              {
                id: ids.search,
                role: 'tool',
                text: `Searching your documents: “${query}”`,
                pending: true,
                createdAt: Date.now(),
              },
            ]);
          } else if (event === 'source') {
            sources.push(data as Source);
          } else if (event === 'token') {
            const piece = (data as { text?: string }).text ?? '';
            setItems((prev) => {
              const done = prev.map((item) =>
                item.id === ids.search ? { ...item, pending: false } : item,
              );
              return done.some((item) => item.id === ids.answer)
                ? done.map((item) =>
                    item.id === ids.answer
                      ? { ...item, text: item.text + piece }
                      : item,
                  )
                : [
                    ...done,
                    {
                      id: ids.answer,
                      role: 'assistant',
                      text: piece,
                      pending: true,
                      createdAt: Date.now(),
                    },
                  ];
            });
          } else if (event === 'done') {
            update(ids.answer, (item) => ({
              ...item,
              pending: false,
              source: toSourceRef(sources),
            }));
          } else if (event === 'error') {
            const e = data as { code?: string; message?: string };
            throw new ApiFailure(
              e.code ?? 'internal',
              e.message ?? 'The answer failed.',
              500,
            );
          }
        });
      } catch (e) {
        setError(
          e instanceof ApiFailure
            ? e.message
            : 'The answer failed. Please try again.',
        );
      } finally {
        setItems((prev) =>
          prev.map((item) =>
            item.id === ids.search || item.id === ids.answer
              ? { ...item, pending: false }
              : item,
          ),
        );
        setBusy(false);
        onAnswered?.();
      }
    },
    [busy, onAnswered],
  );

  return { items, busy, error, clearError: () => setError(null), ask };
}
