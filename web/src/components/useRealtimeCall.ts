'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure, type Source } from '@/lib/api';

export type CallStatus = 'idle' | 'connecting' | 'connected';
export type Speaker = 'user' | 'assistant' | null;
export type MicStatus = 'ok' | 'blocked' | 'insecure';
export type EndReason = 'time' | 'remote' | 'lost';

/** Where the search found matches; shown under the assistant's answer. */
export interface SourceRef {
  document: string;
  pages: string;
}

export interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  pending: boolean;
  source?: SourceRef;
  /** for ordering voice and text items in one transcript */
  createdAt: number;
}

type RealtimeEvent = { type: string; [key: string]: any };

const GREETING =
  'Greet the user in one short sentence and invite them to ask a question about their PDF.';

/** Top document of the search sources and the pages matched in it. */
export function toSourceRef(sources: Source[]): SourceRef | undefined {
  const document = sources[0]?.document;
  if (!document) return undefined;
  const pages = [
    ...new Set(
      sources.filter((s) => s.document === document).map((s) => s.page),
    ),
  ].slice(0, 3);
  return { document, pages: pages.join(', ') };
}

/** Top document of a search_documents result (raw data channel event). */
export function summarizeSources(output: string): SourceRef | undefined {
  try {
    const results: { document?: string; page?: number | string }[] =
      JSON.parse(output)?.results ?? [];
    return toSourceRef(
      results
        .filter((r) => r.document && r.page !== undefined)
        .map((r) => ({ document: r.document!, page: String(r.page) })),
    );
  } catch {
    return undefined;
  }
}

/** WebRTC connection to the OpenAI Realtime API, brokered by POST /v1/pdf/voice/call. */
export function useRealtimeCall(onEnded?: () => void) {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [endReason, setEndReason] = useState<EndReason | null>(null);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [micStatus, setMicStatus] = useState<MicStatus>('ok');
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState<Speaker>(null);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const silentContextRef = useRef<AudioContext | null>(null);
  const callIdRef = useRef<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventsRef = useRef<EventSource | null>(null);
  const endsAtRef = useRef<number | null>(null);
  const responseActiveRef = useRef(false);
  const pendingTextRef = useRef<string | null>(null);
  const pendingSourceRef = useRef<SourceRef | undefined>(undefined);
  const onEndedRef = useRef(onEnded);

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  const upsert = useCallback(
    (
      id: string,
      role: TranscriptItem['role'],
      update: (previous: string) => string,
      pending?: boolean,
      source?: SourceRef,
    ) => {
      setItems((previous) => {
        const index = previous.findIndex((item) => item.id === id);
        if (index === -1) {
          return [
            ...previous,
            {
              id,
              role,
              text: update(''),
              pending: pending ?? false,
              source,
              createdAt: Date.now(),
            },
          ];
        }
        const next = [...previous];
        const current = next[index];
        next[index] = {
          ...current,
          text: update(current.text),
          pending: pending ?? current.pending,
          source: current.source ?? source,
        };
        return next;
      });
    },
    [],
  );

  const send = useCallback((event: RealtimeEvent) => {
    const channel = dcRef.current;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(event));
  }, []);

  const sendUserText = useCallback(
    (text: string) => {
      if (responseActiveRef.current) {
        send({ type: 'response.cancel' });
        send({ type: 'output_audio_buffer.clear' });
      }
      send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      });
      send({ type: 'response.create' });
    },
    [send],
  );

  const handleEvent = useCallback(
    (event: RealtimeEvent) => {
      switch (event.type) {
        case 'conversation.item.added':
        case 'conversation.item.created': {
          const item = event.item;
          if (!item?.id) break;
          if (
            item.type === 'message' &&
            (item.role === 'user' || item.role === 'assistant')
          ) {
            const typed = (item.content ?? [])
              .map((part: { text?: string }) => part.text ?? '')
              .join(' ')
              .trim();
            let source: SourceRef | undefined;
            if (item.role === 'assistant') {
              source = pendingSourceRef.current;
              pendingSourceRef.current = undefined;
            }
            upsert(
              item.id,
              item.role,
              (previous) => previous || typed,
              !typed,
              source,
            );
          } else if (item.type === 'function_call') {
            upsert(
              item.id,
              'tool',
              (previous) => previous || 'Searching your documents…',
              true,
            );
          } else if (item.type === 'function_call_output') {
            pendingSourceRef.current = summarizeSources(item.output ?? '');
            setItems((previous) =>
              previous.map((entry) =>
                entry.role === 'tool' && entry.pending
                  ? { ...entry, pending: false }
                  : entry,
              ),
            );
          }
          break;
        }
        case 'input_audio_buffer.speech_started':
          setSpeaker('user');
          break;
        case 'input_audio_buffer.speech_stopped':
          setSpeaker((current) => (current === 'user' ? null : current));
          break;
        case 'output_audio_buffer.started':
          setSpeaker('assistant');
          setSearchQuery(null);
          break;
        case 'output_audio_buffer.stopped':
        case 'output_audio_buffer.cleared':
          setSpeaker((current) => (current === 'assistant' ? null : current));
          break;
        case 'conversation.item.input_audio_transcription.delta':
          upsert(
            event.item_id,
            'user',
            (previous) => previous + (event.delta ?? ''),
            true,
          );
          break;
        case 'conversation.item.input_audio_transcription.completed':
          upsert(
            event.item_id,
            'user',
            () => (event.transcript ?? '').trim() || '(inaudible)',
            false,
          );
          break;
        case 'conversation.item.input_audio_transcription.failed':
          upsert(
            event.item_id,
            'user',
            (previous) => previous || '(could not transcribe)',
            false,
          );
          break;
        case 'response.output_audio_transcript.delta':
        case 'response.output_text.delta':
          setSearchQuery(null);
          upsert(
            event.item_id,
            'assistant',
            (previous) => previous + (event.delta ?? ''),
            true,
          );
          break;
        case 'response.output_audio_transcript.done':
          upsert(
            event.item_id,
            'assistant',
            (previous) => event.transcript ?? previous,
            false,
          );
          break;
        case 'response.output_text.done':
          upsert(
            event.item_id,
            'assistant',
            (previous) => event.text ?? previous,
            false,
          );
          break;
        case 'response.function_call_arguments.done': {
          let query = '';
          try {
            query = JSON.parse(event.arguments ?? '{}').query ?? '';
          } catch {
            // keep the generic label
          }
          setSearchQuery(query);
          upsert(event.item_id, 'tool', () =>
            query
              ? `Searching your documents: “${query}”`
              : 'Searching your documents…',
          );
          break;
        }
        case 'response.created':
          responseActiveRef.current = true;
          break;
        case 'response.done':
          responseActiveRef.current = false;
          setItems((previous) =>
            previous.map((item) =>
              item.role === 'assistant' && item.pending
                ? { ...item, pending: false }
                : item,
            ),
          );
          break;
        case 'error': {
          const code = event.error?.code ?? '';
          if (code !== 'response_cancel_not_active') {
            setError(event.error?.message ?? 'Unknown error');
          }
          break;
        }
      }
    },
    [upsert],
  );

  /** Ends the call. `reason` is set when the user didn't end it themselves. */
  const stop = useCallback(async (reason?: EndReason) => {
    const callId = callIdRef.current;
    if (!pcRef.current && !callId) return;
    callIdRef.current = null;
    if (reason) setEndReason(reason);

    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
    if (dcRef.current) {
      dcRef.current.onclose = null;
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
    void silentContextRef.current?.close();
    silentContextRef.current = null;
    responseActiveRef.current = false;
    pendingTextRef.current = null;
    pendingSourceRef.current = undefined;
    eventsRef.current?.close();
    eventsRef.current = null;

    setLocalStream(null);
    setRemoteStream(null);
    setSecondsLeft(null);
    setSpeaker(null);
    setSearchQuery(null);
    setMuted(false);
    setStatus('idle');

    if (callId) {
      await api.endVoiceCall(callId).catch(() => undefined);
    }
    onEndedRef.current?.();
  }, []);

  const start = useCallback(
    async (firstMessage?: string) => {
      if (pcRef.current) return;
      setError(null);
      setEndReason(null);
      endsAtRef.current = null;
      setStatus('connecting');
      pendingTextRef.current = firstMessage ?? null;
      try {
        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        const audio = new Audio();
        audio.autoplay = true;
        audioRef.current = audio;
        pc.ontrack = (event) => {
          const [stream] = event.streams;
          audio.srcObject = stream;
          setRemoteStream(stream);
        };

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          setMicStatus('ok');
        } catch {
          // No microphone: send a silent track so text chat still works.
          setMicStatus(window.isSecureContext ? 'blocked' : 'insecure');
          const context = new AudioContext();
          silentContextRef.current = context;
          stream = context.createMediaStreamDestination().stream;
        }
        const hasMic = !silentContextRef.current;
        localStreamRef.current = stream;
        setLocalStream(hasMic ? stream : null);
        setMuted(false);
        pc.addTrack(stream.getAudioTracks()[0], stream);

        const channel = pc.createDataChannel('oai-events');
        dcRef.current = channel;
        channel.onmessage = (message) => {
          try {
            handleEvent(JSON.parse(message.data));
          } catch {
            // ignore malformed events
          }
        };
        channel.onopen = () => {
          setStatus('connected');
          const text = pendingTextRef.current;
          pendingTextRef.current = null;
          if (text) {
            sendUserText(text);
          } else {
            send({
              type: 'response.create',
              response: { instructions: GREETING },
            });
          }
        };
        // Closed by the server: time limit, daily budget or server restart.
        channel.onclose = () => {
          const endsAt = endsAtRef.current;
          void stop(
            endsAt !== null && Date.now() >= endsAt - 3000 ? 'time' : 'remote',
          );
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const call = await api.startVoiceCall(offer.sdp ?? '');
        callIdRef.current = call.callId;
        const maxSeconds = call.maxSeconds;
        await pc.setRemoteDescription({ type: 'answer', sdp: call.sdp });

        // Server-side call events: the reliable source of document/page citations.
        const events = new EventSource(api.voiceEventsUrl(call.callId), {
          withCredentials: true,
        });
        eventsRef.current = events;
        let sources: Source[] = [];
        events.addEventListener('search', () => {
          sources = [];
        });
        events.addEventListener('source', (message) => {
          try {
            sources.push(JSON.parse((message as MessageEvent).data));
            pendingSourceRef.current = toSourceRef(sources);
          } catch {
            // ignore malformed events
          }
        });
        events.addEventListener('ended', () => events.close());
        pc.onconnectionstatechange = () => {
          if (
            pc.connectionState === 'failed' ||
            pc.connectionState === 'closed'
          ) {
            void stop('lost');
          }
        };

        if (maxSeconds > 0) {
          const endsAt = Date.now() + maxSeconds * 1000;
          endsAtRef.current = endsAt;
          setSecondsLeft(maxSeconds);
          countdownRef.current = setInterval(() => {
            const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
            setSecondsLeft(left);
            // The server enforces the limit too; ending here avoids relying on it.
            if (left === 0) void stop('time');
          }, 1000);
        }
      } catch (e) {
        setError(
          e instanceof ApiFailure
            ? e.message
            : 'Could not start the conversation. Please try again.',
        );
        await stop();
      }
    },
    [handleEvent, send, sendUserText, stop],
  );

  /** Sends typed text into the running call (answered by voice). */
  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed && dcRef.current?.readyState === 'open')
        sendUserText(trimmed);
    },
    [sendUserText],
  );

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track || micStatus !== 'ok') return;
    const next = !muted;
    track.enabled = !next;
    setMuted(next);
  }, [micStatus, muted]);

  useEffect(() => {
    const onPageHide = () => void stop();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      void stop();
    };
  }, [stop]);

  return {
    status,
    error,
    clearError: () => setError(null),
    endReason,
    clearEndReason: () => setEndReason(null),
    items,
    secondsLeft,
    micStatus,
    muted,
    speaker,
    searchQuery,
    localStream,
    remoteStream,
    start: () => start(),
    stop: () => stop(),
    sendText,
    toggleMute,
  };
}
