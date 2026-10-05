import { z } from 'zod';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { servePrivacyStreamWithFetcher } from '@/features/privacy-fetch/stream-port';
import { workerTransfer } from '@/utils/worker-transport';
import type { ImageDownloadFetch } from './fetch-types';
const requestSchema = z.object({ url: z.string().url().max(8192), headers: z.array(z.tuple([z.string(), z.string()])).max(8).optional() }).strict();
/** The window owns the sandboxed privacy broker. Workers only receive an
 * authorized byte stream via the existing transfer/backpressure transport.
 * Never import the DOM broker client into a download Worker. */
export function createImageDownloadFetchBridge({ signal }: { signal: AbortSignal }): { open: ImageDownloadFetch, dispose(): void } {
  const connections = new Set<{ channel: MessageChannel, dispose(): Promise<void> }>();
  let disposed = false;
  const open: ImageDownloadFetch = async ({ request }) => {
    signal.throwIfAborted(); if (disposed) throw new Error('Download fetch bridge closed');
    const validated = requestSchema.parse(request);
    const channel = new MessageChannel();
    const server = servePrivacyStreamWithFetcher({ port: channel.port1, fetchResponse: ({ signal: streamSignal }) => {
      return privacyFetchStream({ request: { ...validated, signal: AbortSignal.any([signal, streamSignal]) } });
    } });
    connections.add({ channel, dispose: server.dispose });
    return workerTransfer({ value: channel.port2, transferables: [channel.port2] });
  };
  function dispose(): void {
    if (disposed) return; disposed = true;
    for (const connection of connections) {
      void connection.dispose().catch(() => undefined);
      connection.channel.port1.close(); connection.channel.port2.close();
    }
    connections.clear();
  }
  return { open, dispose };
}
export const TEST_ONLY = {
};
