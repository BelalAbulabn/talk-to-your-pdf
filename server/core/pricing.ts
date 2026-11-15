/** USD per 1M tokens, from developers.openai.com/api/docs/pricing (Nov 2026). */
interface RealtimePrice {
  textIn: number;
  cachedTextIn: number;
  textOut: number;
  audioIn: number;
  cachedAudioIn: number;
  audioOut: number;
}

const FULL: RealtimePrice = {
  textIn: 4,
  cachedTextIn: 0.4,
  textOut: 24,
  audioIn: 32,
  cachedAudioIn: 0.4,
  audioOut: 64,
};

const MINI: RealtimePrice = {
  textIn: 0.6,
  cachedTextIn: 0.06,
  textOut: 2.4,
  audioIn: 10,
  cachedAudioIn: 0.3,
  audioOut: 20,
};

const REALTIME_PRICES: Record<string, RealtimePrice> = {
  'gpt-realtime-2.1': FULL,
  'gpt-realtime-2': FULL,
  'gpt-realtime': { ...FULL, textOut: 16 },
  'gpt-realtime-2.1-mini': MINI,
  'gpt-realtime-mini': MINI,
};

/** Shape of `response.usage` in a Realtime `response.done` event. */
export interface RealtimeUsage {
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/** Shape of `usage` in `conversation.item.input_audio_transcription.completed`. */
export type TranscriptionUsage =
  | { type: 'duration'; seconds: number }
  | { type: 'tokens'; input_tokens: number; output_tokens: number };

const PER_TOKEN = 1 / 1_000_000;

export function realtimeCostUsd(model: string, usage: RealtimeUsage): number {
  // Unknown models are billed at the most expensive rate to stay on the safe side.
  const price = REALTIME_PRICES[model] ?? FULL;
  const input = usage.input_token_details ?? {};
  const cached = input.cached_tokens_details ?? {};
  const output = usage.output_token_details ?? {};

  const cachedText = cached.text_tokens ?? 0;
  const cachedAudio = cached.audio_tokens ?? 0;
  const freshText = Math.max(0, (input.text_tokens ?? 0) - cachedText);
  const freshAudio = Math.max(0, (input.audio_tokens ?? 0) - cachedAudio);

  return (
    (freshText * price.textIn +
      cachedText * price.cachedTextIn +
      freshAudio * price.audioIn +
      cachedAudio * price.cachedAudioIn +
      (output.text_tokens ?? 0) * price.textOut +
      (output.audio_tokens ?? 0) * price.audioOut) *
    PER_TOKEN
  );
}

const TRANSCRIBE_USD_PER_MINUTE = 0.017;
const TRANSCRIBE_TOKEN_IN = 6;
const TRANSCRIBE_TOKEN_OUT = 10;

export function transcriptionCostUsd(
  usage: TranscriptionUsage | undefined,
): number {
  if (!usage) return 0;
  if (usage.type === 'duration') {
    return (usage.seconds / 60) * TRANSCRIBE_USD_PER_MINUTE;
  }
  return (
    (usage.input_tokens * TRANSCRIBE_TOKEN_IN +
      usage.output_tokens * TRANSCRIBE_TOKEN_OUT) *
    PER_TOKEN
  );
}

export function embeddingCostUsd(tokens: number): number {
  return tokens * 0.02 * PER_TOKEN;
}

/** USD per 1M tokens for the /chat text models (Nov 2026). */
interface TextPrice {
  input: number;
  cachedInput: number;
  output: number;
}

const TEXT_PRICES: Record<string, TextPrice> = {
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
};

// Unknown models are billed high so the daily budget errs on the safe side.
const TEXT_FALLBACK: TextPrice = { input: 5, cachedInput: 0.5, output: 30 };

/** Shape of `usage` in a Responses API `response.completed` event. */
export interface TextUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export function textCostUsd(model: string, usage: TextUsage): number {
  // dated snapshots ("gpt-5.4-mini-2026-03-17") use the base model's price
  const key = Object.keys(TEXT_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((name) => model === name || model.startsWith(`${name}-`));
  const price = key ? TEXT_PRICES[key] : TEXT_FALLBACK;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const fresh = Math.max(0, (usage.input_tokens ?? 0) - cached);
  return (
    (fresh * price.input +
      cached * price.cachedInput +
      (usage.output_tokens ?? 0) * price.output) *
    PER_TOKEN
  );
}
