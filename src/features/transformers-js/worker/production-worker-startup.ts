import { z } from 'zod';

export const PRODUCTION_WORKER_READY = {
  channel: 'naidan-production-worker-startup',
  version: 1,
  status: 'ready',
} as const;

export const productionWorkerStartupSchema = z.discriminatedUnion('status', [
  z.object({
    channel: z.literal(PRODUCTION_WORKER_READY.channel),
    version: z.literal(1),
    status: z.literal('ready'),
  }).strict(),
  z.object({
    channel: z.literal(PRODUCTION_WORKER_READY.channel),
    version: z.literal(1),
    status: z.literal('failed'),
    message: z.string().max(2000),
  }).strict(),
]);

/** The entry import resolves only after its synchronous Comlink expose. */
export async function startProductionWorkerRuntime({ loadEntry, postMessage }: {
  loadEntry: () => Promise<unknown>,
  postMessage: ({ message }: { message: z.infer<typeof productionWorkerStartupSchema> }) => void,
}): Promise<void> {
  try {
    await loadEntry();
    postMessage({ message: PRODUCTION_WORKER_READY });
  } catch (error) {
    postMessage({ message: {
      channel: PRODUCTION_WORKER_READY.channel,
      version: 1,
      status: 'failed',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    } });
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
