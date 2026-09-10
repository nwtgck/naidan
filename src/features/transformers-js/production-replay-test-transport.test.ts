// @vitest-environment node
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { exposeWorkerRemote, releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { ProductionReplayTestWorker } from './production-replay-test-transport';

describe('native replay Worker event queue', () => {
  it('keeps an RPC queued while module evaluation has not installed the real consumer', async () => {
    const entryLoaded = Promise.withResolvers<void>();
    const requestSchema = z.object({ runId: z.string() }).strict();
    type Api = { echo(request: z.infer<typeof requestSchema>): Promise<z.infer<typeof requestSchema>> };
    const worker = new ProductionReplayTestWorker({ start: async ({ worker }) => {
      await entryLoaded.promise;
      exposeWorkerRemote<Api>({ api: { echo: async request => requestSchema.parse(request) }, endpoint: worker.endpoint });
    } });
    // This native adapter transfers Node MessagePorts, not browser-only Canvas
    // transferables. Its browser Worker facade retains the actual Comlink wire.
    const remote = wrapWorkerRemote<Api>({ endpoint: worker as unknown as Worker });
    try {
      const pending = remote.echo({ runId: 'queued-before-entry' });
      expect(worker.hostMessages).toHaveLength(1);
      // Registering even an observational Node message listener starts delivery.
      // There must be no consumer until the script's actual entry is installed.
      expect(getEventListeners(worker.channel.port2, 'message')).toHaveLength(0);
      entryLoaded.resolve();
      await expect(pending).resolves.toEqual({ runId: 'queued-before-entry' });
      expect(worker.workerMessages).toHaveLength(1);
    } finally {
      entryLoaded.resolve();
      await releaseWorkerRemote({ remote });
      worker.terminate();
    }
  });
});
