import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { pdfVoiceRoutes } from '../apps/pdf_voice/routes';
import { toErrorBody } from '../core/errors';
import { assertAllowedOrigin, isAllowedOrigin } from './http';

/** The HTTP API: CORS, origin check, health, and the PDF app under /v1/pdf. */
export function createApp(): Hono {
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  );
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' || c.req.method === 'DELETE') {
      assertAllowedOrigin(c);
    }
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/v1/pdf', pdfVoiceRoutes());

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404),
  );
  app.onError((error, c) => {
    const { status, body } = toErrorBody(
      error,
      `${c.req.method} ${c.req.path}`,
    );
    return c.json(body, status as ContentfulStatusCode);
  });

  return app;
}
