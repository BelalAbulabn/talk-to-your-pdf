'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  Clock,
  FileText,
  GitHub,
  Mic,
  MicOff,
  Moon,
  PhoneOff,
  Send,
  Sun,
  Upload,
  X,
} from 'react-feather';
import { APP_NAME, BRAND_HANDLE, REPO_URL } from '@/lib/brand';
import { api, ApiFailure, type DocSummary, type Quota } from '@/lib/api';
import { DocumentsPanel, Slots } from './DocumentsPanel';
import { Transcript } from './Transcript';
import { useRealtimeCall } from './useRealtimeCall';
import { useTextChat } from './useTextChat';
import { VoiceStage, type CoreIcon, type StageTone } from './VoiceStage';

const WARN_SECONDS = 30;
const MIN_VOICE_MINUTES = 1;

type ViewState =
  | 'empty'
  | 'uploading'
  | 'ready'
  | 'connecting'
  | 'listening'
  | 'userSpeaking'
  | 'assistantSpeaking'
  | 'searching'
  | 'micBlocked'
  | 'muted'
  | 'lastSeconds'
  | 'callEnded'
  | 'limit'
  | 'error';

const STAGE: Record<ViewState, [StageTone, CoreIcon, string, string]> = {
  empty: ['off', 'upload', 'Getting started', 'Upload a PDF to wake me up'],
  uploading: ['think', 'wave', 'Preparing', 'Reading your PDF…'],
  ready: ['idle', 'wave', 'Ready when you are', 'Press Start and ask out loud'],
  connecting: ['connect', 'dots', 'Connecting', 'Say hello in a second…'],
  listening: ['idle', 'wave', 'Listening', 'Ask your question'],
  userSpeaking: ['you', 'mic', 'You · speaking', ''],
  assistantSpeaking: ['asst', 'speaker', 'Assistant · speaking', ''],
  searching: ['search', 'search', 'Searching your documents', ''],
  micBlocked: ['text', 'micoff', 'Text-only mode', 'Type your questions below'],
  muted: ['muted', 'micoff', 'Mic off', 'Unmute to talk, or type below'],
  lastSeconds: [
    'warn',
    'time',
    'Less than 30 seconds left',
    'The call ends at 0:00',
  ],
  callEnded: [
    'off',
    'wave',
    'Call ended — time limit',
    'Calls last up to 5 minutes',
  ],
  limit: ['off', 'micoff', 'No voice minutes left today', 'Typing still works'],
  error: ['error', 'alert', 'Connection lost', 'Let’s try that again'],
};

interface Banner {
  tone: 'error' | 'warn' | 'info';
  icon: 'alert' | 'clock' | 'mic';
  title: string;
  text: string;
  onDismiss?: () => void;
  action?: { label: string; run: () => void };
}

function formatSeconds(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Last words of a live transcript, so the caption stays one or two lines. */
function tail(text: string, words = 14): string {
  const parts = text.trim().split(/\s+/);
  return parts.length > words
    ? `… ${parts.slice(-words).join(' ')}`
    : text.trim();
}

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const stored = document.documentElement.dataset.theme;
    setDark(
      stored
        ? stored === 'dark'
        : window.matchMedia('(prefers-color-scheme: dark)').matches,
    );
  }, []);
  const toggle = useCallback(() => {
    setDark((current) => {
      const next = current ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('vcp-theme', next);
      } catch {
        // private mode: the choice lasts for this page only
      }
      return !current;
    });
  }, []);
  return { dark, toggle };
}

export function ChatApp() {
  const [documents, setDocuments] = useState<DocSummary[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const theme = useTheme();

  const refresh = useCallback(async () => {
    try {
      const body = await api.listDocuments();
      setDocuments(body.documents);
      setQuota(body.quota);
    } catch {
      // keep the last known state
    }
  }, []);

  const call = useRealtimeCall(refresh);
  const chat = useTextChat(refresh);

  useEffect(() => {
    api
      .ensureSession()
      .catch(() => undefined)
      .then(refresh);
  }, [refresh]);

  const upload = async (file: File) => {
    setUploadError(null);
    if (quota && file.size > quota.maxUploadMb * 1024 * 1024) {
      setUploadError(
        `The file is too large. The maximum is ${quota.maxUploadMb} MB.`,
      );
      return;
    }
    setUploadingName(file.name);
    try {
      await api.uploadDocument(file);
    } catch (e) {
      setUploadError(
        e instanceof ApiFailure
          ? e.message
          : 'Upload failed. Please check your connection.',
      );
    } finally {
      setUploadingName(null);
      await refresh();
    }
  };

  const remove = async (id: string) => {
    await api.deleteDocument(id).catch(() => undefined);
    await refresh();
  };

  // ---------- derive the view state ----------
  const live = call.status === 'connected';
  const noDocs = documents.length === 0;
  const serviceDown = quota !== null && !quota.serviceAvailable;
  const voiceUsedUp =
    quota !== null && quota.voiceMinutesLeft < MIN_VOICE_MINUTES;
  const voiceLimit = serviceDown || voiceUsedUp;
  const micOk = call.micStatus === 'ok';
  const lastSeconds =
    live && call.secondsLeft !== null && call.secondsLeft <= WARN_SECONDS;

  let view: ViewState;
  if (call.status === 'connecting') view = 'connecting';
  else if (live) {
    if (lastSeconds) view = 'lastSeconds';
    else if (call.searchQuery !== null) view = 'searching';
    else if (call.speaker === 'assistant') view = 'assistantSpeaking';
    else if (call.speaker === 'user') view = 'userSpeaking';
    else if (!micOk) view = 'micBlocked';
    else if (call.muted) view = 'muted';
    else view = 'listening';
  } else if (call.error) view = 'error';
  else if (uploadingName) view = 'uploading';
  else if (call.endReason === 'time') view = 'callEnded';
  else if (voiceLimit) view = 'limit';
  else if (noDocs) view = 'empty';
  else view = 'ready';

  const [tone, core, stageTitle, stageCaption] = STAGE[view];
  const lastUser = [...call.items].reverse().find((i) => i.role === 'user');
  const lastAssistant = [...call.items]
    .reverse()
    .find((i) => i.role === 'assistant');
  let caption = stageCaption;
  let captionLive = false;
  if (view === 'userSpeaking') {
    caption = lastUser?.pending ? tail(lastUser.text) : '';
    captionLive = true;
  } else if (view === 'assistantSpeaking') {
    caption = lastAssistant ? tail(lastAssistant.text) : '';
    captionLive = !!lastAssistant?.pending;
  } else if (view === 'searching') {
    caption = call.searchQuery ? `“${call.searchQuery}”` : '…';
  } else if (view === 'limit' && serviceDown) {
    caption = 'Back tomorrow';
  }
  const title = view === 'limit' && serviceDown ? 'Daily limit' : stageTitle;

  const youState =
    view === 'userSpeaking'
      ? 'Speaking…'
      : !live
        ? 'Off'
        : !micOk
          ? 'Mic unavailable'
          : call.muted
            ? 'Muted'
            : 'Listening';
  const assistantState =
    view === 'assistantSpeaking'
      ? 'Speaking…'
      : view === 'searching'
        ? 'Searching…'
        : view === 'connecting'
          ? 'Joining…'
          : live
            ? 'Waiting'
            : 'Off';

  // ---------- banner ----------
  let banner: Banner | null = null;
  if (live && call.micStatus === 'insecure') {
    banner = {
      tone: 'info',
      icon: 'mic',
      title: 'Voice needs a secure connection',
      text: 'This page isn’t on HTTPS, so the microphone can’t be used. You can still type your questions.',
    };
  } else if (live && call.micStatus === 'blocked') {
    banner = {
      tone: 'info',
      icon: 'mic',
      title: 'Microphone is blocked',
      text: 'You can still type your questions. To use voice, allow microphone access in your browser’s site settings.',
    };
  } else if (view === 'lastSeconds') {
    banner = {
      tone: 'warn',
      icon: 'clock',
      title: 'Less than 30 seconds left',
      text: 'Calls last up to 5 minutes. Finish your question — this call ends at 0:00.',
    };
  } else if (view === 'error') {
    banner = {
      tone: 'error',
      icon: 'alert',
      title: 'Something went wrong',
      text:
        call.error ??
        'We couldn’t reach the assistant. Check your connection and try again.',
      onDismiss: call.clearError,
      action:
        noDocs || voiceLimit
          ? undefined
          : { label: 'Try again', run: () => void call.start() },
    };
  } else if (view === 'callEnded') {
    banner = {
      tone: 'info',
      icon: 'clock',
      title: 'Call ended — time limit',
      text: 'Calls can last up to 5 minutes. Start a new conversation to keep asking questions.',
      onDismiss: call.clearEndReason,
    };
  } else if (!live && call.endReason) {
    banner = {
      tone: 'info',
      icon: 'clock',
      title:
        call.endReason === 'lost' ? 'Connection lost' : 'The call has ended',
      text: 'Start a new conversation to keep asking questions.',
      onDismiss: call.clearEndReason,
    };
  } else if (view === 'limit') {
    banner = serviceDown
      ? {
          tone: 'warn',
          icon: 'clock',
          title: 'The assistant is unavailable for today',
          text: 'Lots of people used it today and we’ve reached our daily limit. It’s available again tomorrow.',
        }
      : {
          tone: 'warn',
          icon: 'clock',
          title: 'You’ve used today’s voice minutes',
          text: 'You can still type your questions. Your voice minutes reset tomorrow.',
        };
  }
  if (!banner && chat.error) {
    banner = {
      tone: 'error',
      icon: 'alert',
      title: 'Couldn’t answer that',
      text: chat.error,
      onDismiss: chat.clearError,
    };
  }

  // ---------- header pill ----------
  let pillClass = '';
  let pillShort = 'Not connected';
  let pillLong = '';
  if (call.status === 'connecting') {
    pillClass = 'pill--warn';
    pillShort = 'Connecting…';
  } else if (live && (call.muted || !micOk)) {
    pillClass = 'pill--muted';
    pillShort = 'Connected';
    pillLong = ' · mic off';
  } else if (live) {
    pillClass = 'pill--live';
    pillShort = 'Listening';
  }

  const startDisabled = noDocs || voiceLimit;
  // Typed questions go to POST /chat; during a call they go into the call instead.
  const inputDisabled =
    noDocs ||
    call.status === 'connecting' ||
    chat.busy ||
    (!live && serviceDown);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || inputDisabled) return;
    if (live) call.sendText(draft);
    else void chat.ask(draft);
    setDraft('');
  };

  const docWord =
    documents.length === 1 ? 'document' : `${documents.length} documents`;
  const transcript = [...chat.items, ...call.items].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  const showTranscript = transcript.length > 0;
  const speaking = view === 'userSpeaking' || view === 'assistantSpeaking';

  return (
    <div className="app reel">
      <header className="hdr">
        <div className="brand">
          <div className={`mark${speaking ? ' live' : ''}`} aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <div className="brand-text">
            <span className="brand-name">{APP_NAME}</span>
            <span className="brand-by">
              by <b>{BRAND_HANDLE}</b>
            </span>
          </div>
        </div>
        <div className="hdr-right">
          <a className="back" href={REPO_URL}>
            <GitHub className="i i-sm" aria-hidden="true" />
            Source
          </a>
          <span
            className={`pill ${pillClass}`}
            role="status"
            aria-live="polite"
          >
            <span className="dot" />
            {pillShort}
            <span className="lbl-long">{pillLong}</span>
          </span>
          <button
            type="button"
            className="iconbtn"
            aria-label="Switch light or dark mode"
            onClick={theme.toggle}
          >
            {theme.dark ? <Sun className="i" /> : <Moon className="i" />}
          </button>
        </div>
      </header>

      {/* phone: compact documents bar */}
      <div className="docbar">
        <button
          type="button"
          className="docbar-btn"
          aria-expanded={docsOpen}
          onClick={() => setDocsOpen((open) => !open)}
        >
          <div className="file-ic" style={{ width: 34, height: 34 }}>
            <FileText className="i i-sm" aria-hidden="true" />
          </div>
          <span className="docbar-text">
            <span className="docbar-name">
              {uploadingName ?? documents[0]?.name ?? 'No documents yet'}
            </span>
            <span className="docbar-count">
              <Slots
                total={quota?.maxFiles ?? 3}
                filled={documents.length}
                processing={!!uploadingName}
              />
              {documents.length} of {quota?.maxFiles ?? 3} files
            </span>
          </span>
          <ChevronDown className="i" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="iconbtn"
          aria-label="Upload a PDF"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="i" />
        </button>
      </div>
      <div
        className={`scrim${docsOpen ? ' open' : ''}`}
        onClick={() => setDocsOpen(false)}
        aria-hidden="true"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />

      <main className="main">
        <DocumentsPanel
          documents={documents}
          quota={quota}
          uploadingName={uploadingName}
          uploadError={uploadError}
          open={docsOpen}
          onClose={() => setDocsOpen(false)}
          onPick={() => fileInputRef.current?.click()}
          onFile={(file) => void upload(file)}
          onDelete={(id) => void remove(id)}
          onDismissError={() => setUploadError(null)}
        />

        <section className="panel convo" aria-label="Conversation">
          <VoiceStage
            tone={tone}
            core={core}
            title={title}
            caption={caption}
            captionLive={captionLive}
            scope={noDocs ? null : `Answers only from your ${docWord}`}
            you={{
              on: view === 'userSpeaking',
              dim: view === 'assistantSpeaking',
              micOff: live && (call.muted || !micOk),
              state: youState,
            }}
            assistant={{
              on: view === 'assistantSpeaking',
              dim: view === 'userSpeaking',
              state: assistantState,
            }}
            secondsLeft={call.secondsLeft}
            warnSeconds={WARN_SECONDS}
            localStream={call.localStream}
            remoteStream={call.remoteStream}
          />

          {banner && (
            <div className="banner-wrap">
              <div
                className={`alert alert--${banner.tone}`}
                role={banner.tone === 'error' ? 'alert' : 'status'}
              >
                {banner.icon === 'alert' && (
                  <AlertTriangle className="i" aria-hidden="true" />
                )}
                {banner.icon === 'clock' && (
                  <Clock className="i" aria-hidden="true" />
                )}
                {banner.icon === 'mic' && (
                  <MicOff className="i" aria-hidden="true" />
                )}
                <div className="alert-body">
                  <p className="alert-title">{banner.title}</p>
                  <p>{banner.text}</p>
                  {banner.action && (
                    <div className="alert-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={banner.action.run}
                      >
                        {banner.action.label}
                      </button>
                    </div>
                  )}
                </div>
                {banner.onDismiss && (
                  <button
                    type="button"
                    className="alert-x"
                    aria-label="Dismiss"
                    onClick={banner.onDismiss}
                  >
                    <X className="i i-sm" />
                  </button>
                )}
              </div>
            </div>
          )}

          {showTranscript ? (
            <Transcript
              items={transcript}
              speaker={call.speaker}
              endedLabel={
                !live && call.endReason === 'time'
                  ? 'Call ended — time limit (5:00)'
                  : null
              }
            />
          ) : noDocs && !live && call.status !== 'connecting' ? (
            <div className="empty">
              <h1>
                Ask your PDF anything. <em>Out loud.</em>
              </h1>
              <p>
                Upload a PDF, then talk or type your question. The assistant
                answers only from your document and tells you the page it found
                the answer on.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-lg btn-glow"
                onClick={() => fileInputRef.current?.click()}
                disabled={!!uploadingName}
              >
                <Upload className="i" aria-hidden="true" />
                Upload your first PDF
              </button>
              <div className="steps">
                <div className="step cur">
                  <div className="step-n">1</div>
                  <p className="step-t">Upload a PDF</p>
                  <p className="step-d">
                    Up to {quota?.maxUploadMb ?? 10} MB and{' '}
                    {quota?.maxPages ?? 50} pages.
                  </p>
                </div>
                <div className="step">
                  <div className="step-n">2</div>
                  <p className="step-t">Start talking</p>
                  <p className="step-d">Or type, if you prefer.</p>
                </div>
                <div className="step">
                  <div className="step-n">3</div>
                  <p className="step-t">Get sourced answers</p>
                  <p className="step-d">With document name and page.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty ready">
              <div className="ready-ic">
                <CheckCircle className="i i-lg" aria-hidden="true" />
              </div>
              <h1>
                {call.status === 'connecting'
                  ? 'Connecting to the assistant…'
                  : live
                    ? 'Listening — ask your question'
                    : 'Your documents are ready'}
              </h1>
              <p>
                {call.status === 'connecting'
                  ? 'Start speaking when the status says Listening.'
                  : live
                    ? 'Speak naturally, or type your question below.'
                    : 'Start a conversation and ask your question out loud, or type it below.'}
              </p>
            </div>
          )}

          <div className="foot">
            <form className="composer" onSubmit={submit}>
              <label className="sr-only" htmlFor="ask">
                Type a question
              </label>
              <div className={`field${inputDisabled ? ' is-disabled' : ''}`}>
                <input
                  id="ask"
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    noDocs
                      ? 'Upload a PDF to ask questions'
                      : 'Ask a question about your documents…'
                  }
                  disabled={inputDisabled}
                  maxLength={2000}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  className="send"
                  aria-label="Send"
                  disabled={inputDisabled || !draft.trim()}
                >
                  <Send className="i i-sm" aria-hidden="true" />
                </button>
              </div>
            </form>

            {call.status === 'connecting' ? (
              <div className="controls">
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled
                >
                  <span className="spin" aria-hidden="true" />
                  Connecting…
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={call.stop}
                >
                  Cancel
                </button>
              </div>
            ) : live && !micOk ? (
              <div className="controls">
                <button type="button" className="btn btn-secondary" disabled>
                  <MicOff className="i" aria-hidden="true" />
                  Voice unavailable
                </button>
                <span
                  className="timer"
                  role="timer"
                  aria-label="Time left in this call"
                >
                  <Clock className="i i-sm" aria-hidden="true" />
                  {formatSeconds(call.secondsLeft ?? 0)}
                </span>
                <div className="ctl-right">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={call.stop}
                  >
                    <PhoneOff className="i" aria-hidden="true" />
                    End
                  </button>
                </div>
              </div>
            ) : live ? (
              <div className="controls">
                <button
                  type="button"
                  className={`btn btn-secondary${call.muted ? ' is-on' : ''}`}
                  onClick={call.toggleMute}
                  aria-pressed={call.muted}
                >
                  {call.muted ? (
                    <MicOff className="i" aria-hidden="true" />
                  ) : (
                    <Mic className="i" aria-hidden="true" />
                  )}
                  {call.muted ? 'Unmute' : 'Mute'}
                </button>
                <span
                  className={`timer${lastSeconds ? ' is-warn' : ''}`}
                  role="timer"
                  aria-label="Time left in this call"
                >
                  <Clock className="i i-sm" aria-hidden="true" />
                  {formatSeconds(call.secondsLeft ?? 0)} left
                </span>
                <div className="ctl-right">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={call.stop}
                  >
                    <PhoneOff className="i" aria-hidden="true" />
                    End
                  </button>
                </div>
              </div>
            ) : (
              <div className="controls">
                <button
                  type="button"
                  className={`btn btn-primary btn-lg${startDisabled ? '' : ' btn-glow'}`}
                  onClick={() => void call.start()}
                  disabled={startDisabled}
                >
                  <Mic className="i" aria-hidden="true" />
                  {voiceLimit
                    ? 'Voice available tomorrow'
                    : call.endReason
                      ? 'Start new conversation'
                      : 'Start conversation'}
                </button>
                <span className="hint">
                  {noDocs
                    ? 'Upload a PDF to start.'
                    : serviceDown
                      ? 'Back tomorrow.'
                      : voiceLimit
                        ? 'Typing still works.'
                        : 'Or just type your question below.'}
                </span>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="ftr">
        <span>
          {APP_NAME} by <b>{BRAND_HANDLE}</b>
        </span>
        <span className="sp">Answers come only from your uploaded PDFs.</span>
        <span className="x2">Files are deleted after 24 hours.</span>
      </footer>
    </div>
  );
}
