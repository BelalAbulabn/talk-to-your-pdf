import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Limits } from './config';
import { UsageTracker } from './usage';

const limits: Limits = {
  dailyBudgetUsd: 10,
  maxCallSeconds: 300,
  voiceSecondsPerIpPerDay: 900,
  maxConcurrentCalls: 2,
  maxUploadBytes: 10 * 1024 * 1024,
  maxPdfPages: 50,
  maxDocsPerVisitor: 3,
  uploadsPerIpPerDay: 2,
  callsPerIpPerDay: 3,
  chatsPerIpPerDay: 2,
  docTtlMs: 24 * 3600 * 1000,
};

const DAY = Date.UTC(2026, 10, 11, 12);

describe('UsageTracker', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps a call at the per-call limit and the remaining daily minutes', () => {
    const tracker = new UsageTracker(limits, null, () => DAY);
    const ip = tracker.ipKey('1.2.3.4');

    const first = tracker.beginCall(ip);
    expect(first).toEqual({ ok: true, maxSeconds: 300 });
    tracker.endCall(ip, 700);

    expect(tracker.beginCall(ip)).toEqual({ ok: true, maxSeconds: 200 });
    tracker.endCall(ip, 200);

    expect(tracker.beginCall(ip).ok).toBe(false);
  });

  it('allows only one running call per IP and limits concurrent calls overall', () => {
    const tracker = new UsageTracker(limits, null, () => DAY);
    const a = tracker.ipKey('1.1.1.1');
    const b = tracker.ipKey('2.2.2.2');
    const c = tracker.ipKey('3.3.3.3');

    expect(tracker.beginCall(a).ok).toBe(true);
    expect(tracker.beginCall(a).ok).toBe(false);
    expect(tracker.beginCall(b).ok).toBe(true);
    expect(tracker.beginCall(c).ok).toBe(false);

    tracker.endCall(a, 10);
    expect(tracker.beginCall(c).ok).toBe(true);
  });

  it('blocks calls and uploads once the daily budget is spent', () => {
    const tracker = new UsageTracker(limits, null, () => DAY);
    const ip = tracker.ipKey('1.2.3.4');
    tracker.addSpend(9.99);
    expect(tracker.budgetExceeded()).toBe(false);
    tracker.addSpend(0.02);
    expect(tracker.budgetExceeded()).toBe(true);
    expect(tracker.beginCall(ip).ok).toBe(false);
    expect(tracker.checkUpload(ip)?.code).toBe('service_daily_limit');
    expect(tracker.checkChat(ip)?.code).toBe('service_daily_limit');
  });

  it('limits uploads per IP per day', () => {
    const tracker = new UsageTracker(limits, null, () => DAY);
    const ip = tracker.ipKey('1.2.3.4');
    tracker.recordUpload(ip);
    expect(tracker.checkUpload(ip)).toBeNull();
    tracker.recordUpload(ip);
    expect(tracker.checkUpload(ip)?.code).toBe('upload_limit');
  });

  it('limits the number of calls per IP per day', () => {
    const tracker = new UsageTracker(limits, null, () => DAY);
    const ip = tracker.ipKey('1.2.3.4');
    for (let i = 0; i < 3; i++) {
      expect(tracker.beginCall(ip).ok).toBe(true);
      tracker.endCall(ip, 5);
    }
    const blocked = tracker.beginCall(ip);
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.code).toBe('call_limit');
  });

  it('resets counters on the next UTC day', () => {
    let now = DAY;
    const tracker = new UsageTracker(limits, null, () => now);
    const ip = tracker.ipKey('1.2.3.4');
    tracker.addSpend(50);
    tracker.beginCall(ip);
    tracker.endCall(ip, 900);
    expect(tracker.voiceSecondsLeft(ip)).toBe(0);

    now += 24 * 3600 * 1000;
    expect(tracker.budgetExceeded()).toBe(false);
    expect(tracker.voiceSecondsLeft(ip)).toBe(900);
  });

  it('persists counters and the IP salt across restarts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    dirs.push(dir);
    const file = path.join(dir, 'usage.json');

    const first = new UsageTracker(limits, file, () => DAY);
    const ip = first.ipKey('1.2.3.4');
    first.beginCall(ip);
    first.endCall(ip, 120);
    first.addSpend(1.5);
    first.flush();

    const second = new UsageTracker(limits, file, () => DAY);
    expect(second.ipKey('1.2.3.4')).toBe(ip);
    expect(second.voiceSecondsLeft(ip)).toBe(780);
    expect(second.budgetLeftUsd()).toBeCloseTo(8.5);
  });

  it('limits text questions per IP per day', () => {
    const tracker = new UsageTracker(limits, null, () => DAY);
    const ip = tracker.ipKey('1.2.3.4');
    tracker.recordChat(ip);
    expect(tracker.checkChat(ip)).toBeNull();
    tracker.recordChat(ip);
    expect(tracker.checkChat(ip)?.code).toBe('chat_limit');
  });
});
