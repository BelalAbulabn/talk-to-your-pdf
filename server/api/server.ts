import { serve } from '@hono/node-server';
import { config } from '../core/config';
import { createApp } from './app';
import { handleShutdown, onServerStart } from './lifecycle';

const { port, webOrigins } = config();

await onServerStart();

const server = serve(
  { fetch: createApp().fetch, port, hostname: '0.0.0.0' },
  (info) => {
    console.log(
      `[server] talk-to-your-pdf API listening on :${info.port} (web origins: ${webOrigins.join(', ')})`,
    );
  },
);

handleShutdown(() => server.close());
