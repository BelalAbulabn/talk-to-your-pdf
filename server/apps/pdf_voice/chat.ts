import { config } from '../../core/config';
import { ApiError } from '../../core/errors';
import { OPENAI_BASE_URL, openaiApiKey } from '../../core/openai';
import { textCostUsd, type TextUsage } from '../../core/pricing';
import { docStore } from '../../core/rag/store';
import { usage } from '../../core/usage';
import { buildChatInstructions } from './instructions';
import {
  formatExcerpts,
  searchDocuments,
  sourcesOf,
  type Source,
} from './search';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  question: string;
  history: ChatMessage[];
}

/** Events of POST /v1/pdf/chat (same names as the voice event stream where they overlap). */
export type ChatEvent =
  | { event: 'search'; data: { query: string } }
  | { event: 'source'; data: Source }
  | { event: 'token'; data: { text: string } }
  | { event: 'done'; data: Record<string, never> };

const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_CHARS = 4000;

export function parseChatRequest(body: unknown): ChatRequest {
  const input = (body ?? {}) as { question?: unknown; history?: unknown };
  const question =
    typeof input.question === 'string' ? input.question.trim() : '';
  if (!question || question.length > MAX_QUESTION_CHARS) {
    throw new ApiError(
      'invalid_request',
      `Please send a question of 1 to ${MAX_QUESTION_CHARS} characters.`,
    );
  }
  const rawHistory = Array.isArray(input.history) ? input.history : [];
  const history = rawHistory
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string',
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_HISTORY_CHARS),
    }));
  return { question, history };
}

/** Checks limits before the stream starts, so refusals are normal JSON errors. */
export async function prepareChat(
  visitorId: string,
  ipKey: string,
): Promise<string[]> {
  const tracker = usage();
  const refusal = tracker.checkChat(ipKey);
  if (refusal) throw new ApiError(refusal.code, refusal.reason);
  const documents = await docStore().list(visitorId);
  if (documents.length === 0) {
    throw new ApiError(
      'no_documents',
      'Upload a PDF first, then ask your question.',
    );
  }
  tracker.recordChat(ipKey);
  return documents.map((d) => d.name);
}

export async function* answerQuestion(
  visitorId: string,
  documentNames: string[],
  { question, history }: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  yield { event: 'search', data: { query: question } };
  const hits = await searchDocuments(visitorId, question);
  for (const source of sourcesOf(hits)) yield { event: 'source', data: source };

  const cfg = config();
  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${openaiApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.chatModel,
      instructions: buildChatInstructions(documentNames),
      input: [
        ...history,
        {
          role: 'user',
          content: `Excerpts from the user's documents:\n\n${
            formatExcerpts(hits) || '(no matching excerpts)'
          }\n\nQuestion: ${question}`,
        },
      ],
      stream: true,
      store: false,
      max_output_tokens: 1500,
      ...(cfg.chatReasoningEffort !== 'none' && cfg.chatReasoningEffort
        ? { reasoning: { effort: cfg.chatReasoningEffort } }
        : {}),
    }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OpenAI /responses failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  for await (const event of readSse(response.body)) {
    if (event.type === 'response.output_text.delta' && event.delta) {
      yield { event: 'token', data: { text: String(event.delta) } };
    } else if (event.type === 'response.completed') {
      const used = (event.response as { usage?: TextUsage } | undefined)?.usage;
      if (used) usage().addSpend(textCostUsd(cfg.chatModel, used));
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(
        `OpenAI stream failed: ${JSON.stringify(event).slice(0, 300)}`,
      );
    }
  }
  yield { event: 'done', data: {} };
}

/** Parses a Server-Sent Events byte stream into its JSON `data:` payloads. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type?: string; [key: string]: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        // ignore malformed blocks
      }
    }
  }
}
