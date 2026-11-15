import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { config } from '../../core/config';
import { ApiError } from '../../core/errors';
import { OPENAI_BASE_URL, openaiApiKey } from '../../core/openai';
import {
  realtimeCostUsd,
  transcriptionCostUsd,
  type RealtimeUsage,
  type TranscriptionUsage,
} from '../../core/pricing';
import { docStore } from '../../core/rag/store';
import { usage } from '../../core/usage';
import { callEvents, type EndReason } from './events';
import {
  buildInstructions,
  buildSession,
  SEARCH_TOOL_NAME,
} from './instructions';
import { pageLabel, searchDocuments, sourcesOf, type Source } from './search';

interface ActiveCall {
  id: string;
  visitorId: string;
  ipKey: string;
  startedAt: number;
  socket: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
  /** live transcript text per conversation item */
  transcripts: Map<string, { role: 'user' | 'assistant'; text: string }>;
}

interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ServerEvent {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  item?: {
    id?: string;
    type?: string;
    role?: string;
    content?: { type?: string; text?: string }[];
  };
  response?: {
    status?: string;
    usage?: RealtimeUsage;
    output?: Array<{ type: string } & Partial<FunctionCallItem>>;
  };
  usage?: TranscriptionUsage;
  error?: { message?: string };
}

export interface StartedCall {
  callId: string;
  answerSdp: string;
  maxSeconds: number;
}

const SIDEBAND_URL = 'wss://api.openai.com/v1/realtime';
const SIDEBAND_TIMEOUT_MS = 10_000;

const globalState = globalThis as typeof globalThis & {
  __itCalls?: Map<string, ActiveCall>;
};
const calls = (globalState.__itCalls ??= new Map<string, ActiveCall>());

function activeCallsFile(): string {
  return path.join(config().storageDir, 'active-calls.json');
}

/** Records running call ids so calls orphaned by a crash can be ended on the next start. */
function persistActiveCalls(): void {
  try {
    const file = activeCallsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...calls.keys()]));
  } catch (error) {
    console.error('[calls] failed to persist active calls', error);
  }
}

async function hangUp(callId: string): Promise<void> {
  try {
    await fetch(
      `${OPENAI_BASE_URL}/realtime/calls/${encodeURIComponent(callId)}/hangup`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiApiKey()}` },
      },
    );
  } catch (error) {
    console.warn(`[call ${callId}] hangup request failed`, error);
  }
}

/** Ends calls left over from a previous server process (crash or hard kill). */
export async function hangUpOrphanedCalls(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = JSON.parse(fs.readFileSync(activeCallsFile(), 'utf8'));
  } catch {
    return;
  }
  const orphaned = ids.filter((id) => typeof id === 'string' && !calls.has(id));
  if (orphaned.length > 0) {
    console.log(`[calls] ending ${orphaned.length} orphaned call(s)`);
    await Promise.all(orphaned.map(hangUp));
  }
  persistActiveCalls();
}

/** Ends every running call, e.g. on server shutdown. */
export async function endAllCalls(reason: EndReason): Promise<void> {
  await Promise.all([...calls.keys()].map((id) => endCall(id, reason)));
}

/**
 * Creates the WebRTC call with the server-side API key and attaches a sideband
 * WebSocket, so tools, costs and time limits are handled on the server.
 */
export async function startCall(
  visitorId: string,
  ipKey: string,
  offerSdp: string,
): Promise<StartedCall> {
  const tracker = usage();
  const gate = tracker.beginCall(ipKey);
  if (!gate.ok) throw new ApiError(gate.code, gate.reason);

  let call: ActiveCall | null = null;
  try {
    const documents = await docStore().list(visitorId);
    const form = new FormData();
    form.set('sdp', offerSdp);
    form.set(
      'session',
      JSON.stringify(buildSession(documents.map((d) => d.name))),
    );
    const response = await fetch(`${OPENAI_BASE_URL}/realtime/calls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiApiKey()}` },
      body: form,
    });
    const answerSdp = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenAI /realtime/calls failed (${response.status}): ${answerSdp.slice(0, 500)}`,
      );
    }
    const callId = response.headers
      .get('location')
      ?.split('/')
      .filter(Boolean)
      .pop();
    if (!callId) throw new Error('OpenAI did not return a call id');

    call = {
      id: callId,
      visitorId,
      ipKey,
      startedAt: Date.now(),
      socket: null,
      timer: null,
      finished: false,
      transcripts: new Map(),
    };
    calls.set(callId, call);
    persistActiveCalls();
    await openSideband(call);
    call.timer = setTimeout(
      () => void endCall(callId, 'time_limit'),
      gate.maxSeconds * 1000,
    );
    console.log(`[call ${callId}] started (limit ${gate.maxSeconds}s)`);
    return { callId, answerSdp, maxSeconds: gate.maxSeconds };
  } catch (error) {
    if (call) {
      await endCall(call.id, 'disconnected');
    } else {
      tracker.endCall(ipKey, 0);
    }
    throw error;
  }
}

/** Whether the call exists (running, or ended within the last minute) and belongs to the visitor. */
export function callBelongsTo(callId: string, visitorId: string): boolean {
  const call = calls.get(callId);
  if (call) return call.visitorId === visitorId;
  return ownersOfEnded.get(callId) === visitorId;
}

// Owners of recently ended calls, so their event streams can still be read.
const ownersOfEnded = new Map<string, string>();

/** Ends a call if it belongs to the visitor. Returns false if it is unknown. */
export async function endVisitorCall(
  callId: string,
  visitorId: string,
): Promise<boolean> {
  const call = calls.get(callId);
  if (!call || call.visitorId !== visitorId) return false;
  await endCall(callId, 'ended_by_user');
  return true;
}

/** Pushes the new document list into running calls of this visitor. */
export async function notifyDocumentsChanged(visitorId: string): Promise<void> {
  const active = [...calls.values()].filter((c) => c.visitorId === visitorId);
  if (active.length === 0) return;
  const names = (await docStore().list(visitorId)).map((d) => d.name);
  for (const call of active) {
    send(call, {
      type: 'session.update',
      session: { type: 'realtime', instructions: buildInstructions(names) },
    });
  }
}

async function endCall(callId: string, reason: EndReason): Promise<void> {
  const call = calls.get(callId);
  if (!call || call.finished) return;
  call.finished = true;
  if (call.timer) clearTimeout(call.timer);

  const seconds = (Date.now() - call.startedAt) / 1000;
  usage().endCall(call.ipKey, seconds);
  console.log(
    `[call ${callId}] ended after ${Math.round(seconds)}s (${reason})`,
  );

  const hub = callEvents();
  hub.publish(callId, { event: 'ended', data: { reason } });
  ownersOfEnded.set(callId, call.visitorId);
  setTimeout(() => ownersOfEnded.delete(callId), 60_000).unref?.();
  hub.forget(callId);

  call.socket?.terminate();
  await hangUp(callId);
  calls.delete(callId);
  persistActiveCalls();
}

function openSideband(call: ActiveCall): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${SIDEBAND_URL}?call_id=${encodeURIComponent(call.id)}`,
      { headers: { Authorization: `Bearer ${openaiApiKey()}` } },
    );
    call.socket = socket;
    const timeout = setTimeout(() => {
      reject(new Error('Sideband connection timed out'));
      socket.terminate();
    }, SIDEBAND_TIMEOUT_MS);

    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.on('message', (data) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleEvent(call, event).catch((error) =>
        console.error(`[call ${call.id}] event handling failed`, error),
      );
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      console.error(`[call ${call.id}] sideband error: ${error.message}`);
      reject(error);
    });
    // Without the sideband there is no cost control, so the call must end too.
    socket.on('close', () => {
      clearTimeout(timeout);
      void endCall(call.id, 'disconnected');
    });
  });
}

/** Publishes the full transcript text of an item so far ("replace, don't append"). */
function publishTranscript(
  call: ActiveCall,
  itemId: string | undefined,
  role: 'user' | 'assistant',
  update: (previous: string) => string,
  final: boolean,
): void {
  if (!itemId) return;
  const entry = call.transcripts.get(itemId) ?? { role, text: '' };
  entry.text = update(entry.text);
  call.transcripts.set(itemId, entry);
  callEvents().publish(call.id, {
    event: 'transcript',
    data: { itemId, role: entry.role, text: entry.text, final },
  });
  if (final) call.transcripts.delete(itemId);
}

async function handleEvent(
  call: ActiveCall,
  event: ServerEvent,
): Promise<void> {
  switch (event.type) {
    case 'conversation.item.input_audio_transcription.delta':
      publishTranscript(
        call,
        event.item_id,
        'user',
        (t) => t + (event.delta ?? ''),
        false,
      );
      return;
    case 'conversation.item.input_audio_transcription.completed':
      usage().addSpend(transcriptionCostUsd(event.usage));
      publishTranscript(
        call,
        event.item_id,
        'user',
        (t) => event.transcript?.trim() || t,
        true,
      );
      return;
    case 'conversation.item.added': {
      // questions typed into the call over the data channel
      const item = event.item;
      const typed = item?.content
        ?.filter((part) => part.type === 'input_text')
        .map((part) => part.text ?? '')
        .join(' ')
        .trim();
      if (item?.type === 'message' && item.role === 'user' && typed) {
        publishTranscript(call, item.id, 'user', () => typed, true);
      }
      return;
    }
    case 'response.output_audio_transcript.delta':
    case 'response.output_text.delta':
      publishTranscript(
        call,
        event.item_id,
        'assistant',
        (t) => t + (event.delta ?? ''),
        false,
      );
      return;
    case 'response.output_audio_transcript.done':
    case 'response.output_text.done':
      publishTranscript(
        call,
        event.item_id,
        'assistant',
        (t) => event.transcript ?? event.text ?? t,
        true,
      );
      return;
    case 'response.done': {
      const response = event.response ?? {};
      if (response.usage) {
        usage().addSpend(
          realtimeCostUsd(config().realtimeModel, response.usage),
        );
      }
      if (usage().budgetExceeded()) {
        await endCall(call.id, 'daily_limit');
        return;
      }
      if (response.status !== 'completed') return;
      const toolCalls = (response.output ?? []).filter(
        (item): item is FunctionCallItem => item.type === 'function_call',
      );
      if (toolCalls.length === 0) return;
      for (const item of toolCalls) {
        const { output, sources } = await runTool(
          call,
          item.name,
          item.arguments,
        );
        for (const source of sources) {
          callEvents().publish(call.id, { event: 'source', data: source });
        }
        send(call, {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: item.call_id,
            output: JSON.stringify(output),
          },
        });
      }
      send(call, { type: 'response.create' });
      return;
    }
    case 'error':
      console.warn(
        `[call ${call.id}] realtime error: ${event.error?.message ?? 'unknown'}`,
      );
      return;
  }
}

async function runTool(
  call: ActiveCall,
  name: string,
  rawArguments: string,
): Promise<{ output: unknown; sources: Source[] }> {
  if (name !== SEARCH_TOOL_NAME) {
    return { output: { error: `Unknown tool: ${name}` }, sources: [] };
  }

  let query = '';
  try {
    query = String(JSON.parse(rawArguments || '{}').query ?? '').trim();
  } catch {
    // handled below
  }
  if (!query)
    return { output: { error: 'The search query is missing.' }, sources: [] };
  callEvents().publish(call.id, { event: 'search', data: { query } });

  if ((await docStore().list(call.visitorId)).length === 0) {
    return {
      output: {
        results: [],
        note: 'The user has not uploaded any documents yet. Ask them to upload a PDF.',
      },
      sources: [],
    };
  }
  try {
    const hits = await searchDocuments(call.visitorId, query);
    return {
      output: {
        results: hits.map((hit) => ({
          document: hit.document,
          page: pageLabel(hit),
          text: hit.text,
        })),
      },
      sources: sourcesOf(hits),
    };
  } catch (error) {
    console.error(`[call ${call.id}] search failed`, error);
    return {
      output: { error: 'Document search is temporarily unavailable.' },
      sources: [],
    };
  }
}

function send(call: ActiveCall, event: object): void {
  if (call.socket?.readyState === WebSocket.OPEN) {
    call.socket.send(JSON.stringify(event));
  }
}
