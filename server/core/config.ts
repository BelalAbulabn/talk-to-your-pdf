export interface Limits {
  dailyBudgetUsd: number;
  maxCallSeconds: number;
  voiceSecondsPerIpPerDay: number;
  callsPerIpPerDay: number;
  chatsPerIpPerDay: number;
  maxConcurrentCalls: number;
  maxUploadBytes: number;
  maxPdfPages: number;
  maxDocsPerVisitor: number;
  uploadsPerIpPerDay: number;
  docTtlMs: number;
}

export interface Config {
  port: number;
  realtimeModel: string;
  realtimeVoice: string;
  transcribeModel: string;
  chatModel: string;
  chatReasoningEffort: string;
  embeddingModel: string;
  embeddingDimensions: number;
  storageDir: string;
  trustProxy: boolean;
  /** Frontend origins allowed by CORS, e.g. https://pdf.example.com */
  webOrigins: string[];
  cookieSameSite: 'Lax' | 'None';
  limits: Limits;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Env ${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function str(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function load(): Config {
  return {
    port: num('PORT', 3000),
    realtimeModel: str('REALTIME_MODEL', 'gpt-realtime-2.1-mini'),
    realtimeVoice: str('REALTIME_VOICE', 'marin'),
    transcribeModel: str('TRANSCRIBE_MODEL', 'gpt-realtime-whisper'),
    chatModel: str('CHAT_MODEL', 'gpt-5.4-mini'),
    chatReasoningEffort: str('CHAT_REASONING_EFFORT', 'low'),
    embeddingModel: str('EMBEDDING_MODEL', 'text-embedding-3-small'),
    embeddingDimensions: num('EMBEDDING_DIM', 512),
    storageDir: str('STORAGE_DIR', './storage'),
    trustProxy: str('TRUST_PROXY', 'false').toLowerCase() === 'true',
    webOrigins: str('WEB_ORIGIN', 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter(Boolean),
    cookieSameSite:
      str('COOKIE_SAMESITE', 'lax').toLowerCase() === 'none' ? 'None' : 'Lax',
    limits: {
      dailyBudgetUsd: num('DAILY_BUDGET_USD', 10),
      maxCallSeconds: num('MAX_CALL_MINUTES', 5) * 60,
      voiceSecondsPerIpPerDay: num('VOICE_MINUTES_PER_IP_PER_DAY', 15) * 60,
      callsPerIpPerDay: num('MAX_CALLS_PER_IP_PER_DAY', 30),
      chatsPerIpPerDay: num('MAX_CHATS_PER_IP_PER_DAY', 100),
      maxConcurrentCalls: num('MAX_CONCURRENT_CALLS', 10),
      maxUploadBytes: num('MAX_UPLOAD_MB', 10) * 1024 * 1024,
      maxPdfPages: num('MAX_PDF_PAGES', 50),
      maxDocsPerVisitor: num('MAX_DOCS_PER_VISITOR', 3),
      uploadsPerIpPerDay: num('UPLOADS_PER_IP_PER_DAY', 10),
      docTtlMs: num('DOC_TTL_HOURS', 24) * 3600 * 1000,
    },
  };
}

let cached: Config | undefined;

/** Read lazily so the values come from the runtime environment. */
export function config(): Config {
  cached ??= load();
  return cached;
}
