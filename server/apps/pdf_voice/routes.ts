import { Hono, type Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { clientIp, sessionId } from '../../api/http';
import { config } from '../../core/config';
import { ApiError, toErrorBody } from '../../core/errors';
import { ingestPdf } from '../../core/rag/ingest';
import { docStore } from '../../core/rag/store';
import { usage } from '../../core/usage';
import {
  callBelongsTo,
  endVisitorCall,
  notifyDocumentsChanged,
  startCall,
} from './calls';
import { answerQuestion, parseChatRequest, prepareChat } from './chat';
import { callEvents, type CallEvent } from './events';

// multipart overhead on top of the file itself
const FORM_OVERHEAD_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
const KEEPALIVE_MS = 15_000;

function ipKey(c: Context): string {
  return usage().ipKey(clientIp(c));
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError('invalid_request', 'The request body must be JSON.');
  }
}

/** SSE with headers that stop nginx from buffering the stream. */
function sse(c: Context, run: (stream: SSEStreamingApi) => Promise<void>) {
  c.header('Cache-Control', 'no-store');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    try {
      await run(stream);
    } catch (error) {
      const { body } = toErrorBody(error, `${c.req.method} ${c.req.path}`);
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify(body.error),
      });
    }
  });
}

/** Routes of the PDF voice app, mounted at /v1/pdf. */
export function pdfVoiceRoutes(): Hono {
  const app = new Hono();

  app.post('/session', (c) => c.json({ sessionId: sessionId(c, true) }));

  app.get('/documents', async (c) => {
    const visitor = sessionId(c);
    const tracker = usage();
    const ip = ipKey(c);
    const { limits } = config();
    const documents = await docStore().list(visitor);
    c.header('Cache-Control', 'no-store');
    return c.json({
      documents,
      quota: {
        files: documents.length,
        maxFiles: limits.maxDocsPerVisitor,
        voiceMinutesLeft: Math.floor(tracker.voiceSecondsLeft(ip) / 60),
        voiceMinutesPerDay: Math.floor(limits.voiceSecondsPerIpPerDay / 60),
        maxUploadMb: limits.maxUploadBytes / (1024 * 1024),
        maxPages: limits.maxPdfPages,
        uploadsLeftToday: tracker.uploadsLeft(ip),
        maxCallSeconds: limits.maxCallSeconds,
        serviceAvailable: !tracker.budgetExceeded(),
      },
    });
  });

  app.post('/documents', async (c) => {
    const visitor = sessionId(c);
    const { limits } = config();
    const maxMb = limits.maxUploadBytes / (1024 * 1024);
    const tooLarge = () =>
      new ApiError(
        'file_too_large',
        `The file is too large. The maximum is ${maxMb} MB.`,
      );

    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > limits.maxUploadBytes + FORM_OVERHEAD_BYTES)
      throw tooLarge();

    const tracker = usage();
    const ip = ipKey(c);
    const refusal = tracker.checkUpload(ip);
    if (refusal) throw new ApiError(refusal.code, refusal.reason);

    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw new ApiError(
        'invalid_request',
        'Please send the PDF as multipart form data.',
      );
    }
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw new ApiError('invalid_request', 'Please choose a PDF file.');
    }
    if (file.size > limits.maxUploadBytes) throw tooLarge();

    tracker.recordUpload(ip);
    const document = await ingestPdf(
      visitor,
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    await notifyDocumentsChanged(visitor);
    return c.json(document, 201);
  });

  app.delete('/documents/:id', async (c) => {
    const visitor = sessionId(c);
    const removed = await docStore().remove(visitor, c.req.param('id'));
    if (!removed)
      throw new ApiError('not_found', 'This document does not exist.');
    await notifyDocumentsChanged(visitor);
    return c.body(null, 204);
  });

  app.post('/chat', async (c) => {
    const visitor = sessionId(c);
    const request = parseChatRequest(await jsonBody(c));
    const documentNames = await prepareChat(visitor, ipKey(c));
    const abort = new AbortController();
    return sse(c, async (stream) => {
      stream.onAbort(() => abort.abort());
      for await (const event of answerQuestion(
        visitor,
        documentNames,
        request,
        abort.signal,
      )) {
        if (stream.aborted) break;
        await stream.writeSSE({
          event: event.event,
          data: JSON.stringify(event.data),
        });
      }
    });
  });

  app.post('/voice/call', async (c) => {
    const visitor = sessionId(c);
    const body = (await jsonBody(c)) as { sdp?: unknown };
    const offer = typeof body.sdp === 'string' ? body.sdp : '';
    if (!offer.startsWith('v=') || offer.length > MAX_SDP_BYTES) {
      throw new ApiError('invalid_request', 'Invalid connection request.');
    }
    const call = await startCall(visitor, ipKey(c), offer);
    c.header('Cache-Control', 'no-store');
    return c.json(
      { callId: call.callId, sdp: call.answerSdp, maxSeconds: call.maxSeconds },
      201,
    );
  });

  app.delete('/voice/call/:callId', async (c) => {
    const ended = await endVisitorCall(c.req.param('callId'), sessionId(c));
    if (!ended) throw new ApiError('not_found', 'This call does not exist.');
    return c.body(null, 204);
  });

  app.get('/voice/call/:callId/events', (c) => {
    const callId = c.req.param('callId');
    if (!callBelongsTo(callId, sessionId(c))) {
      throw new ApiError('not_found', 'This call does not exist.');
    }
    return sse(
      c,
      (stream) =>
        new Promise<void>((resolve) => {
          let chain = Promise.resolve();
          const keepAlive = setInterval(() => {
            chain = chain.then(() =>
              stream.write(': keep-alive\n\n').then(() => undefined),
            );
          }, KEEPALIVE_MS);
          const finish = () => {
            clearInterval(keepAlive);
            unsubscribe();
            chain.then(resolve, resolve);
          };
          const unsubscribe = callEvents().subscribe(
            callId,
            (event: CallEvent) => {
              chain = chain.then(() =>
                stream.writeSSE({
                  event: event.event,
                  data: JSON.stringify(event.data),
                }),
              );
              if (event.event === 'ended') queueMicrotask(finish);
            },
          );
          stream.onAbort(finish);
        }),
    );
  });

  return app;
}
