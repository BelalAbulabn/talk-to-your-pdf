import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, type Limits } from './config';
import type { ErrorCode } from './errors';

interface IpUsage {
  voiceSeconds: number;
  uploads: number;
  calls: number;
  chats: number;
}

interface UsageState {
  day: string;
  spentUsd: number;
  salt: string;
  ips: Record<string, IpUsage>;
}

export interface Refusal {
  code: ErrorCode;
  reason: string;
}

export type CallGate =
  { ok: true; maxSeconds: number } | ({ ok: false } & Refusal);

const DAILY_LIMIT: Refusal = {
  code: 'service_daily_limit',
  reason:
    'The daily usage limit of this service has been reached. Please come back tomorrow.',
};

const MIN_CALL_SECONDS = 15;

/**
 * Daily cost and per-IP limits. IPs are only stored as salted hashes.
 * Counters reset at 00:00 UTC and are persisted so restarts don't reset them.
 */
export class UsageTracker {
  private state: UsageState;
  private readonly activeByIp = new Map<string, number>();
  private activeTotal = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly limits: Limits,
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.state = this.load();
  }

  ipKey(ip: string): string {
    return crypto
      .createHash('sha256')
      .update(this.state.salt + ip)
      .digest('hex')
      .slice(0, 32);
  }

  budgetLeftUsd(): number {
    this.rollover();
    return Math.max(0, this.limits.dailyBudgetUsd - this.state.spentUsd);
  }

  budgetExceeded(): boolean {
    return this.budgetLeftUsd() <= 0;
  }

  addSpend(usd: number): void {
    if (!(usd > 0)) return;
    this.rollover();
    this.state.spentUsd += usd;
    this.scheduleSave();
  }

  voiceSecondsLeft(ipKey: string): number {
    this.rollover();
    const used = this.state.ips[ipKey]?.voiceSeconds ?? 0;
    return Math.max(0, this.limits.voiceSecondsPerIpPerDay - used);
  }

  uploadsLeft(ipKey: string): number {
    this.rollover();
    const used = this.state.ips[ipKey]?.uploads ?? 0;
    return Math.max(0, this.limits.uploadsPerIpPerDay - used);
  }

  /** Reserves a call slot. Every successful call must be followed by exactly one endCall(). */
  beginCall(ipKey: string): CallGate {
    if (this.budgetExceeded()) {
      return { ok: false, ...DAILY_LIMIT };
    }
    if (this.activeTotal >= this.limits.maxConcurrentCalls) {
      return {
        ok: false,
        code: 'service_busy',
        reason:
          'Too many conversations are running right now. Please try again in a few minutes.',
      };
    }
    if ((this.activeByIp.get(ipKey) ?? 0) > 0) {
      return {
        ok: false,
        code: 'call_in_progress',
        reason: 'A conversation is already running from your connection.',
      };
    }
    if ((this.state.ips[ipKey]?.calls ?? 0) >= this.limits.callsPerIpPerDay) {
      return {
        ok: false,
        code: 'call_limit',
        reason:
          'You have started too many conversations today. Please come back tomorrow.',
      };
    }
    const left = this.voiceSecondsLeft(ipKey);
    if (left < MIN_CALL_SECONDS) {
      return {
        ok: false,
        code: 'voice_minutes_used',
        reason:
          'You have used all your voice minutes for today. Please come back tomorrow.',
      };
    }
    this.activeByIp.set(ipKey, 1);
    this.activeTotal++;
    this.ipUsage(ipKey).calls++;
    this.scheduleSave();
    return {
      ok: true,
      maxSeconds: Math.floor(Math.min(this.limits.maxCallSeconds, left)),
    };
  }

  endCall(ipKey: string, seconds: number): void {
    this.activeByIp.delete(ipKey);
    this.activeTotal = Math.max(0, this.activeTotal - 1);
    this.rollover();
    this.ipUsage(ipKey).voiceSeconds += Math.max(0, seconds);
    this.scheduleSave();
  }

  /** Returns why the upload is not allowed, or null. */
  checkUpload(ipKey: string): Refusal | null {
    if (this.budgetExceeded()) return DAILY_LIMIT;
    if (this.uploadsLeft(ipKey) <= 0) {
      return {
        code: 'upload_limit',
        reason: 'You have reached the upload limit for today.',
      };
    }
    return null;
  }

  /** Returns why a text question is not allowed, or null. */
  checkChat(ipKey: string): Refusal | null {
    if (this.budgetExceeded()) return DAILY_LIMIT;
    this.rollover();
    if ((this.state.ips[ipKey]?.chats ?? 0) >= this.limits.chatsPerIpPerDay) {
      return {
        code: 'chat_limit',
        reason:
          'You have asked too many questions today. Please come back tomorrow.',
      };
    }
    return null;
  }

  recordChat(ipKey: string): void {
    this.rollover();
    this.ipUsage(ipKey).chats++;
    this.scheduleSave();
  }

  recordUpload(ipKey: string): void {
    this.rollover();
    this.ipUsage(ipKey).uploads++;
    this.scheduleSave();
  }

  flush(): void {
    if (!this.file) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[usage] failed to save usage state', error);
    }
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private rollover(): void {
    const today = this.today();
    if (this.state.day !== today) {
      this.state = { ...this.state, day: today, spentUsd: 0, ips: {} };
      this.scheduleSave();
    }
  }

  private ipUsage(ipKey: string): IpUsage {
    const entry = (this.state.ips[ipKey] ??= {
      voiceSeconds: 0,
      uploads: 0,
      calls: 0,
      chats: 0,
    });
    // state files written before these fields existed
    entry.calls ??= 0;
    entry.chats ??= 0;
    return entry;
  }

  private load(): UsageState {
    const fresh: UsageState = {
      day: this.today(),
      spentUsd: 0,
      salt: crypto.randomBytes(16).toString('hex'),
      ips: {},
    };
    if (!this.file) return fresh;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof parsed?.salt === 'string' && typeof parsed?.day === 'string') {
        return { ...fresh, ...parsed };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[usage] ignoring unreadable usage state', error);
      }
    }
    return fresh;
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
    this.saveTimer.unref?.();
  }
}

const globalState = globalThis as typeof globalThis & {
  __itUsage?: UsageTracker;
};

export function usage(): UsageTracker {
  if (!globalState.__itUsage) {
    const cfg = config();
    const tracker = new UsageTracker(
      cfg.limits,
      path.join(cfg.storageDir, 'usage.json'),
    );
    process.on('exit', () => tracker.flush());
    globalState.__itUsage = tracker;
  }
  return globalState.__itUsage;
}
