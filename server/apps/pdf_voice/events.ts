import type { Source } from './search';

export type EndReason =
  | 'time_limit'
  | 'ended_by_user'
  | 'daily_limit'
  | 'disconnected'
  | 'server_shutdown';

/** Events of one voice call, as streamed by GET /v1/pdf/voice/call/{id}/events. */
export type CallEvent =
  | {
      event: 'transcript';
      data: {
        itemId: string;
        role: 'user' | 'assistant';
        text: string;
        final: boolean;
      };
    }
  | { event: 'search'; data: { query: string } }
  | { event: 'source'; data: Source }
  | { event: 'ended'; data: { reason: EndReason } };

type Listener = (event: CallEvent) => void;

const REPLAY_LIMIT = 100;

/**
 * Fan-out of call events to SSE subscribers. Keeps the last events of each call
 * so a subscriber that connects slightly after the call started misses nothing.
 */
export class CallEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly history = new Map<string, CallEvent[]>();

  publish(callId: string, event: CallEvent): void {
    const history = this.history.get(callId) ?? [];
    history.push(event);
    if (history.length > REPLAY_LIMIT) history.shift();
    this.history.set(callId, history);
    for (const listener of this.listeners.get(callId) ?? []) listener(event);
  }

  /** Replays past events, then forwards new ones. Returns the unsubscribe function. */
  subscribe(callId: string, listener: Listener): () => void {
    for (const event of this.history.get(callId) ?? []) listener(event);
    const set = this.listeners.get(callId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(callId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(callId);
    };
  }

  /** Whether the call published `ended` (its stream is complete). */
  hasEnded(callId: string): boolean {
    return (this.history.get(callId) ?? []).some((e) => e.event === 'ended');
  }

  /** Drops a finished call's history after subscribers had time to read it. */
  forget(callId: string, delayMs = 60_000): void {
    setTimeout(() => this.history.delete(callId), delayMs).unref?.();
  }
}

const globalState = globalThis as typeof globalThis & {
  __itCallEvents?: CallEventHub;
};

export function callEvents(): CallEventHub {
  globalState.__itCallEvents ??= new CallEventHub();
  return globalState.__itCallEvents;
}
