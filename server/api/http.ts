import crypto from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { config } from '../core/config';
import { ApiError } from '../core/errors';
import { isUuid } from '../core/ids';

const SESSION_COOKIE = 'it_session';

function isHttps(c: Context): boolean {
  return (
    c.req.header('x-forwarded-proto') === 'https' ||
    new URL(c.req.url).protocol === 'https:'
  );
}

/** Client IP: from the trusted reverse proxy (nginx/Caddy) or the socket. */
export function clientIp(c: Context): string {
  if (config().trustProxy) {
    const last = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (last) return last;
    const realIp = c.req.header('x-real-ip')?.trim();
    if (realIp) return realIp;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The anonymous session id from the cookie; creates one when `create` is set. */
export function sessionId(c: Context, create = false): string {
  const existing = getCookie(c, SESSION_COOKIE);
  if (existing && isUuid(existing)) return existing;
  if (!create) {
    throw new ApiError(
      'session_required',
      'Your session expired. Please reload the page.',
    );
  }
  const id = crypto.randomUUID();
  const sameSite = config().cookieSameSite;
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite,
    secure: sameSite === 'None' || isHttps(c),
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
  return id;
}

export function isAllowedOrigin(origin: string): boolean {
  return config().webOrigins.includes(origin.replace(/\/$/, ''));
}

/** CSRF protection for POST/DELETE, in addition to the SameSite cookie. */
export function assertAllowedOrigin(c: Context): void {
  const origin = c.req.header('origin');
  if (!origin || isAllowedOrigin(origin)) return;
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    // invalid Origin header: rejected below
  }
  if (!host || originHost !== host) {
    throw new ApiError('forbidden_origin', 'Request from an unknown website.');
  }
}
