// Client for the PDF API (contract: docs/api.md in the repository root).

export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

const BASE = `${API_URL}/v1/pdf`;

export interface DocSummary {
  id: string;
  name: string;
  pages: number;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
}

export interface Quota {
  files: number;
  maxFiles: number;
  voiceMinutesLeft: number;
  voiceMinutesPerDay: number;
  maxUploadMb: number;
  maxPages: number;
  uploadsLeftToday: number;
  maxCallSeconds: number;
  serviceAvailable: boolean;
}

export interface Source {
  document: string;
  page: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** An API error: `code` is one of the documented error codes. */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

async function failure(res: Response): Promise<ApiFailure> {
  const body = await res.json().catch(() => null);
  return new ApiFailure(
    body?.error?.code ?? 'internal',
    body?.error?.message ?? `Request failed (${res.status}).`,
    res.status,
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { credentials: 'include', ...init });
  } catch {
    throw new ApiFailure(
      'network',
      'Could not reach the server. Please check your connection.',
      0,
    );
  }
  if (!res.ok) throw await failure(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  ensureSession: () =>
    request<{ sessionId: string }>('/session', { method: 'POST' }),

  listDocuments: () =>
    request<{ documents: DocSummary[]; quota: Quota }>('/documents', {
      cache: 'no-store',
    }),

  uploadDocument: (file: File) => {
    const form = new FormData();
    form.set('file', file);
    return request<DocSummary>('/documents', { method: 'POST', body: form });
  },

  deleteDocument: (id: string) =>
    request<void>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  startVoiceCall: (sdp: string) =>
    request<{ callId: string; sdp: string; maxSeconds: number }>(
      '/voice/call',
      json({ sdp }),
    ),

  endVoiceCall: (callId: string) =>
    request<void>(`/voice/call/${encodeURIComponent(callId)}`, {
      method: 'DELETE',
      keepalive: true,
    }),

  voiceEventsUrl: (callId: string) =>
    `${BASE}/voice/call/${encodeURIComponent(callId)}/events`,
};

export type ChatEventHandler = (event: string, data: unknown) => void;

/** POST /chat and dispatch its SSE events (search, source, token, done, error). */
export async function streamChat(
  question: string,
  history: ChatMessage[],
  onEvent: ChatEventHandler,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat`, {
      ...json({ question, history }),
      credentials: 'include',
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    throw new ApiFailure(
      'network',
      'Could not reach the server. Please check your connection.',
      0,
    );
  }
  if (!res.ok || !res.body) throw await failure(res);

  const reader = res.body.getReader();
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
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(data.join('\n'));
      } catch {
        continue;
      }
      onEvent(event, parsed);
    }
  }
}
