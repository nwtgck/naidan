import { z } from 'zod';
import { runtimeModuleBytesSchema, runtimeModuleVariantSchema } from '@/features/transformers-js/runtime/production-runtime-module';

export const PRODUCTION_WORKER_READY = {
  channel: 'naidan-production-worker-startup',
  version: 2,
  status: 'ready',
} as const;

export const productionWorkerStartupSchema = z.discriminatedUnion('status', [
  z.object({
    channel: z.literal(PRODUCTION_WORKER_READY.channel),
    version: z.literal(2),
    status: z.literal('ready'),
    requestId: z.uuid(),
  }).strict(),
  z.object({
    channel: z.literal(PRODUCTION_WORKER_READY.channel),
    version: z.literal(2),
    status: z.literal('failed'),
    message: z.string().max(2000),
  }).strict(),
  z.object({
    channel: z.literal(PRODUCTION_WORKER_READY.channel), version: z.literal(2),
    status: z.literal('runtime-module'), requestId: z.uuid(),
    variant: runtimeModuleVariantSchema, bytes: runtimeModuleBytesSchema,
  }).strict(),
]);

export const productionRuntimeModuleReplySchema = z.object({
  channel: z.literal(PRODUCTION_WORKER_READY.channel), version: z.literal(2),
  status: z.literal('runtime-module-ready'), requestId: z.uuid(),
  objectUrl: z.string().max(2048).refine(value => {
    try {
      return new URL(value).protocol === 'blob:';
    } catch {
      return false;
    }
  }, 'Runtime module lease must be a Blob URL'),
}).strict();

export type RequestProductionRuntimeModule = ({ variant, bytes }: {
  variant: z.infer<typeof runtimeModuleVariantSchema>; bytes: Uint8Array;
}) => Promise<{ requestId: string; objectUrl: string }>;

/* eslint-disable local-rules-named-args/require-named-args -- Native message endpoint method signatures. */
export interface ProductionRuntimeModuleEndpoint {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'messageerror', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'messageerror', listener: () => void): void;
  postMessage(message: unknown): void;
}
/* eslint-enable local-rules-named-args/require-named-args */

export function createProductionRuntimeModuleRequester({ endpoint }: {
  endpoint: ProductionRuntimeModuleEndpoint;
}): { requestRuntimeModule: RequestProductionRuntimeModule } {
  let requested = false;
  return {
    requestRuntimeModule({ variant, bytes }) {
      if (requested) return Promise.reject(new Error('Runtime module lease was already requested'));
      requested = true;
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        function cleanup() {
          endpoint.removeEventListener('message', onMessage);
          endpoint.removeEventListener('messageerror', onMessageError);
        }
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Worker event boundary.
        function onMessage(event: MessageEvent<unknown>) {
          const value = event.data;
          if (typeof value !== 'object' || value === null || !('channel' in value) || value.channel !== PRODUCTION_WORKER_READY.channel) return;
          const parsed = productionRuntimeModuleReplySchema.safeParse(value);
          cleanup();
          if (!parsed.success || parsed.data.requestId !== requestId) {
            reject(new Error('Invalid runtime module lease acknowledgement'));
          } else {
            resolve({ requestId, objectUrl: parsed.data.objectUrl });
          }
        }
        function onMessageError() {
          cleanup(); reject(new Error('Runtime module lease acknowledgement could not be deserialized'));
        }

        endpoint.addEventListener('message', onMessage);
        endpoint.addEventListener('messageerror', onMessageError);
        try {
          endpoint.postMessage(productionWorkerStartupSchema.parse({
            ...PRODUCTION_WORKER_READY, status: 'runtime-module', requestId, variant, bytes,
          }));
        } catch (error) {
          cleanup(); reject(error);
        }
      });
    },
  };
}

/** Entry initialization includes verified native module import before expose. */
export async function startProductionWorkerRuntime({ loadEntry, postMessage }: {
  loadEntry: () => Promise<{ requestId: string }>,
  postMessage: ({ message }: { message: z.infer<typeof productionWorkerStartupSchema> }) => void,
}): Promise<void> {
  try {
    const { requestId } = await loadEntry();
    postMessage({ message: { ...PRODUCTION_WORKER_READY, requestId } });
  } catch (error) {
    postMessage({ message: {
      channel: PRODUCTION_WORKER_READY.channel,
      version: PRODUCTION_WORKER_READY.version,
      status: 'failed',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    } });
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
