'use client';

import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import {
  AlertCircle,
  Mic,
  MicOff,
  Search,
  Upload,
  Volume2,
} from 'react-feather';

export type StageTone =
  | 'off'
  | 'idle'
  | 'think'
  | 'connect'
  | 'you'
  | 'asst'
  | 'search'
  | 'muted'
  | 'text'
  | 'warn'
  | 'error';

export type CoreIcon =
  | 'wave'
  | 'upload'
  | 'dots'
  | 'mic'
  | 'speaker'
  | 'search'
  | 'micoff'
  | 'alert'
  | 'time';

export interface VoiceStageProps {
  tone: StageTone;
  core: CoreIcon;
  title: string;
  caption: string;
  captionLive: boolean;
  scope: string | null;
  you: { on: boolean; dim: boolean; micOff: boolean; state: string };
  assistant: { on: boolean; dim: boolean; state: string };
  secondsLeft: number | null;
  warnSeconds: number;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

const RAYS = Array.from({ length: 48 }, (_, i) => ({
  a: `${i * 7.5}deg`,
  d: `${(0.55 + ((i * 29) % 11) * 0.06).toFixed(2)}s`,
  delay: `-${((i * 0.17) % 1.2).toFixed(2)}s`,
}));

const BARS = Array.from({ length: 14 }, (_, i) => ({
  d: `${(0.6 + ((i * 37) % 9) * 0.07).toFixed(2)}s`,
  delay: `-${((i * 0.13) % 1).toFixed(2)}s`,
  delay2: `-${((i * 0.29) % 1).toFixed(2)}s`,
}));

const RING_LENGTH = 590.6;

/** Writes the live audio level (0..1) of both streams into `--lvl` on the element. */
function useAudioLevel(
  target: RefObject<HTMLElement>,
  streams: (MediaStream | null)[],
) {
  const [a, b] = streams;
  useEffect(() => {
    const element = target.current;
    const active = [a, b].filter(
      (s): s is MediaStream => !!s && s.getAudioTracks().length > 0,
    );
    if (!element || active.length === 0) {
      element?.style.setProperty('--lvl', '0');
      return;
    }
    const context = new AudioContext();
    const analysers = active.map((stream) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      return { analyser, bins: new Uint8Array(analyser.frequencyBinCount) };
    });
    let level = 0;
    let frame = 0;
    const tick = () => {
      let peak = 0;
      for (const { analyser, bins } of analysers) {
        analyser.getByteFrequencyData(bins);
        const band = bins.length / 2; // speech sits in the lower half
        let sum = 0;
        for (let i = 0; i < band; i++) sum += bins[i];
        peak = Math.max(peak, sum / band / 160);
      }
      level = level * 0.7 + Math.min(1, peak) * 0.3;
      element.style.setProperty('--lvl', level.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      element.style.setProperty('--lvl', '0');
      void context.close();
    };
  }, [target, a, b]);
}

function CoreGlyph({
  core,
  secondsLeft,
}: {
  core: CoreIcon;
  secondsLeft: number | null;
}) {
  switch (core) {
    case 'upload':
      return <Upload className="i" />;
    case 'dots':
      return (
        <span className="core-dots">
          <i />
          <i />
          <i />
        </span>
      );
    case 'mic':
      return <Mic className="i" />;
    case 'speaker':
      return <Volume2 className="i" />;
    case 'search':
      return <Search className="i" />;
    case 'micoff':
      return <MicOff className="i" />;
    case 'alert':
      return <AlertCircle className="i" />;
    case 'time':
      return (
        <span className="core-count">
          0:{String(secondsLeft ?? 0).padStart(2, '0')}
        </span>
      );
    default:
      return (
        <span className="core-eq">
          <i />
          <i />
          <i />
          <i />
        </span>
      );
  }
}

export function VoiceStage(props: VoiceStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  useAudioLevel(stageRef, [props.localStream, props.remoteStream]);

  const ringOffset =
    props.tone === 'warn' && props.secondsLeft !== null
      ? RING_LENGTH *
        (1 - Math.max(0, Math.min(1, props.secondsLeft / props.warnSeconds)))
      : 0;

  return (
    <div
      ref={stageRef}
      className={`stage st-${props.tone}`}
      aria-label="Voice activity"
    >
      <div className="stage-top">
        <span className="stage-label">
          <i />
          Conversation
        </span>
        {props.scope && (
          <span className="stage-scope">
            <Search className="i i-sm" aria-hidden="true" />
            <span>{props.scope}</span>
          </span>
        )}
      </div>

      <div
        className={`spk spk--you${props.you.on ? ' on' : ''}${props.you.dim ? ' dim' : ''}`}
      >
        <span className="spk-tag">
          {props.you.micOff ? (
            <MicOff className="i i-sm" aria-hidden="true" />
          ) : (
            <Mic className="i i-sm" aria-hidden="true" />
          )}
          You
        </span>
        <div className="minibars" aria-hidden="true">
          {BARS.map((bar, i) => (
            <i
              key={i}
              style={
                {
                  '--d': bar.d,
                  animationDelay: bar.delay,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <span className="spk-state">{props.you.state}</span>
      </div>

      <div className="orb-center">
        <div className="orb-wrap" aria-hidden="true">
          <span className="halo" />
          <span className="rays">
            {RAYS.map((ray, i) => (
              <span
                key={i}
                className="ray"
                style={{ '--a': ray.a } as CSSProperties}
              >
                <b
                  style={
                    {
                      '--d': ray.d,
                      animationDelay: ray.delay,
                    } as CSSProperties
                  }
                />
              </span>
            ))}
          </span>
          <span className="ring" />
          <span className="ring r2" />
          <span className="ring r3" />
          <span className="spinring" />
          <span className="orbit">
            <i />
            <i />
            <i />
          </span>
          {props.tone === 'warn' && (
            <svg className="tring" viewBox="0 0 200 200">
              <circle className="bg" cx="100" cy="100" r="94" />
              <circle
                className="fg"
                cx="100"
                cy="100"
                r="94"
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={ringOffset}
              />
            </svg>
          )}
          <div className="orb">
            <div className="blob" />
            <div className="blob b2" />
          </div>
          <div className="core">
            <CoreGlyph core={props.core} secondsLeft={props.secondsLeft} />
          </div>
        </div>
      </div>

      <div
        className={`spk spk--asst${props.assistant.on ? ' on' : ''}${props.assistant.dim ? ' dim' : ''}`}
      >
        <span className="spk-tag">
          Assistant
          <Volume2 className="i i-sm" aria-hidden="true" />
        </span>
        <div className="minibars" aria-hidden="true">
          {BARS.map((bar, i) => (
            <i
              key={i}
              style={
                {
                  '--d': bar.d,
                  animationDelay: bar.delay2,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <span className="spk-state">{props.assistant.state}</span>
      </div>

      <div className="cap" role="status" aria-live="polite">
        <p className="cap-title">{props.title}</p>
        <p className={`cap-big${props.captionLive ? ' is-live' : ''}`}>
          {props.caption}
        </p>
      </div>
    </div>
  );
}
