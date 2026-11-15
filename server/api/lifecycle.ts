import { endAllCalls, hangUpOrphanedCalls } from '../apps/pdf_voice/calls';
import { docStore } from '../core/rag/store';
import { usage } from '../core/usage';

const SHUTDOWN_TIMEOUT_MS = 8_000;

export async function onServerStart(): Promise<void> {
  docStore(); // starts the expiry sweep
  await hangUpOrphanedCalls().catch((error) =>
    console.error('[server] orphaned call cleanup failed', error),
  );
}

/** Hangs up running calls so they don't continue without limits, then exits. */
export function handleShutdown(closeServer: () => void): void {
  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, ending active calls`);
    await Promise.race([
      endAllCalls('server_shutdown'),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    usage().flush();
    closeServer();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
