import { describe, expect, it } from 'vitest';
import { realtimeCostUsd, textCostUsd, transcriptionCostUsd } from './pricing';

describe('realtimeCostUsd', () => {
  it('prices fresh, cached and output tokens separately', () => {
    const cost = realtimeCostUsd('gpt-realtime-2.1-mini', {
      input_token_details: {
        text_tokens: 1_000_000,
        audio_tokens: 1_000_000,
        cached_tokens_details: { text_tokens: 500_000, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 0, audio_tokens: 1_000_000 },
    });
    // 0.5M fresh text * 0.60 + 0.5M cached text * 0.06 + 1M audio * 10 + 1M audio out * 20
    expect(cost).toBeCloseTo(0.3 + 0.03 + 10 + 20);
  });

  it('falls back to the most expensive rates for unknown models', () => {
    const usage = { output_token_details: { audio_tokens: 1_000_000 } };
    expect(realtimeCostUsd('some-future-model', usage)).toBe(64);
  });

  it('handles empty usage', () => {
    expect(realtimeCostUsd('gpt-realtime-2.1', {})).toBe(0);
  });
});

describe('transcriptionCostUsd', () => {
  it('prices duration-based usage per minute', () => {
    expect(transcriptionCostUsd({ type: 'duration', seconds: 60 })).toBeCloseTo(
      0.017,
    );
  });

  it('ignores missing usage', () => {
    expect(transcriptionCostUsd(undefined)).toBe(0);
  });
});

describe('textCostUsd', () => {
  it('prices dated snapshots like their base model', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 500_000 },
    };
    const cost = 0.5 * 0.75 + 0.5 * 0.075 + 4.5;
    expect(textCostUsd('gpt-5.4-mini', usage)).toBeCloseTo(cost);
    expect(textCostUsd('gpt-5.4-mini-2026-03-17', usage)).toBeCloseTo(cost);
  });

  it('uses high fallback prices for unknown models', () => {
    expect(textCostUsd('mystery-model', { output_tokens: 1_000_000 })).toBe(30);
  });
});
