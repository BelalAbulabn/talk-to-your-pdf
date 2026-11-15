import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
process.env.STORAGE_DIR = storage;
process.env.WEB_ORIGIN = 'https://web.example.de';
process.env.MAX_UPLOAD_MB = '1';
process.env.TRUST_PROXY = 'false';

const WEB = 'https://web.example.de';
let app: Hono;

beforeAll(async () => {
  const { createApp } = await import('./app');
  app = createApp();
});

afterAll(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

// Response bodies are untyped JSON in these tests.
async function json(res: Response): Promise<any> {
  return res.json();
}

async function session(): Promise<string> {
  const res = await app.request('/v1/pdf/session', {
    method: 'POST',
    headers: { Origin: WEB },
  });
  return res.headers.get('set-cookie')!.split(';')[0];
}

function upload(cookie: string, file: File) {
  const form = new FormData();
  form.set('file', file);
  return app.request('/v1/pdf/documents', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: WEB },
    body: form,
  });
}

describe('session', () => {
  it('creates an httpOnly session cookie and returns its id', async () => {
    const res = await app.request('/v1/pdf/session', {
      method: 'POST',
      headers: { Origin: WEB },
    });
    expect(res.status).toBe(200);
    const { sessionId } = await json(res);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`it_session=${sessionId}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('keeps an existing session', async () => {
    const cookie = await session();
    const res = await app.request('/v1/pdf/session', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: WEB },
    });
    expect((await json(res)).sessionId).toBe(cookie.split('=')[1]);
  });

  it('rejects requests without a session', async () => {
    const res = await app.request('/v1/pdf/documents');
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({
      error: { code: 'session_required', message: expect.any(String) },
    });
  });
});

describe('documents', () => {
  it('lists documents with the quota', async () => {
    const res = await app.request('/v1/pdf/documents', {
      headers: { Cookie: await session() },
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.documents).toEqual([]);
    expect(body.quota).toMatchObject({
      files: 0,
      maxFiles: 3,
      voiceMinutesLeft: 15,
    });
  });

  it('rejects files that are not PDFs', async () => {
    const res = await upload(
      await session(),
      new File(['hello'], 'notes.pdf', { type: 'application/pdf' }),
    );
    expect(res.status).toBe(415);
    expect((await json(res)).error.code).toBe('not_pdf');
  });

  it('rejects files over the size limit', async () => {
    const big = new Uint8Array(1.2 * 1024 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    const res = await upload(
      await session(),
      new File([big], 'big.pdf', { type: 'application/pdf' }),
    );
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe('file_too_large');
  });

  it('returns not_found for unknown documents', async () => {
    const res = await app.request('/v1/pdf/documents/abc', {
      method: 'DELETE',
      headers: { Cookie: await session(), Origin: WEB },
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });
});

describe('chat and voice', () => {
  it('needs a document before chatting', async () => {
    const res = await app.request('/v1/pdf/chat', {
      method: 'POST',
      headers: {
        Cookie: await session(),
        Origin: WEB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: 'When is invoice 4711 due?' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('no_documents');
  });

  it('validates the chat question', async () => {
    const res = await app.request('/v1/pdf/chat', {
      method: 'POST',
      headers: {
        Cookie: await session(),
        Origin: WEB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: '' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('invalid_request');
  });

  it('rejects an invalid WebRTC offer', async () => {
    const res = await app.request('/v1/pdf/voice/call', {
      method: 'POST',
      headers: {
        Cookie: await session(),
        Origin: WEB,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sdp: 'garbage' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('invalid_request');
  });

  it("does not expose another session's call events", async () => {
    const res = await app.request('/v1/pdf/voice/call/rtc_unknown/events', {
      headers: { Cookie: await session() },
    });
    expect(res.status).toBe(404);
  });
});

describe('cors and csrf', () => {
  it('allows the configured web origin with credentials', async () => {
    const res = await app.request('/v1/pdf/documents', {
      method: 'OPTIONS',
      headers: {
        Origin: WEB,
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('blocks writes from other websites', async () => {
    const res = await app.request('/v1/pdf/session', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('forbidden_origin');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers unknown routes with the error format', async () => {
    const res = await app.request('/v1/nope');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });

  it('serves the health check', async () => {
    const res = await app.request('/health');
    expect(await json(res)).toEqual({ ok: true });
  });
});
