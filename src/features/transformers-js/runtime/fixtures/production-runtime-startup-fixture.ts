import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { randomUUID, webcrypto } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import { hostedTransformersRuntimeAssetManifestEntry, type HostedTransformersRuntimeVariant } from '@/features/transformers-js/runtime/runtime-asset-manifest';
import { PRODUCTION_WORKER_READY, productionRuntimeModuleReplySchema, createProductionRuntimeModuleRequester, startProductionWorkerRuntime, type RequestProductionRuntimeModule, type ProductionRuntimeModuleEndpoint } from '@/features/transformers-js/worker/production-worker-startup';
import { createProductionWorkerSession } from '@/features/transformers-js/worker/production-worker-session';
import { promiseAllKeyed } from '@/utils/promise';

const restorations: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorations.splice(0).reverse()) restore();
});

/** Native Blob/WebCrypto and explicit browser object-URL platform simulation. */
export function installProductionRuntimeStartupPlatform({ origin }: { origin: string }) {
  for (const [name, value] of [
    ['Blob', NodeBlob],
    ['crypto', { subtle: webcrypto.subtle, randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto) }],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restorations.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const blobs = new Map<string, Blob>();
  const createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:${origin}/${randomUUID()}`;
    blobs.set(url, blob);
    return url;
  });
  const revokeObjectURL = vi.fn((url: string) => {
    blobs.delete(url);
  });
  for (const [name, value] of [['createObjectURL', createObjectURL], ['revokeObjectURL', revokeObjectURL]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(URL, name);
    Object.defineProperty(URL, name, { configurable: true, value });
    restorations.push(() => {
      if (descriptor) Object.defineProperty(URL, name, descriptor);
      else Reflect.deleteProperty(URL, name);
    });
  }
  return { blobs, createObjectURL, revokeObjectURL };
}

export function productionRuntimeModuleFixtureBytes({ variant }: { variant: HostedTransformersRuntimeVariant }): Uint8Array<ArrayBuffer> {
  const entry = hostedTransformersRuntimeAssetManifestEntry({ variant });
  // Original installed runtime asset, already pinned by the compiled manifest.
  // No investigation ZIP, external download, or model-specific expectation.
  return Uint8Array.from(readFileSync(resolve(process.cwd(), 'node_modules/onnxruntime-web/dist', entry.sourceMjsFileName)));
}

/**
 * A fake Worker speaks the real validated host protocol; it cannot declare
 * ready first. Native Blob import is not exercised by this Worker facade;
 * actual entry initialization has independent platform-boundary coverage.
 */
export function createProductionRuntimeStartupFixture({ emitFromWorker }: {
  emitFromWorker: ({ message }: { message: unknown }) => void;
}) {
  const requestId = randomUUID();
  const readyMessage = { ...PRODUCTION_WORKER_READY, requestId };
  const completion = Promise.withResolvers<void>();
  let started = false;
  return {
    ready: completion.promise,
    readyMessage,
    start() {
      if (started) throw new Error('Fixture startup already started');
      started = true;
      emitFromWorker({ message: {
        ...PRODUCTION_WORKER_READY, status: 'runtime-module', requestId, variant: 'asyncify',
        bytes: productionRuntimeModuleFixtureBytes({ variant: 'asyncify' }),
      } });
    },
    acceptHostMessage({ message }: { message: unknown }): boolean {
      const parsed = productionRuntimeModuleReplySchema.safeParse(message);
      if (!parsed.success) return false;
      if (!started || parsed.data.requestId !== requestId) throw new Error('Fixture received a foreign module lease');
      emitFromWorker({ message: readyMessage });
      completion.resolve();
      return true;
    },
  };
}

/** Direct-entry replay shares requester, host verification/lease, initializer and ready. */
export async function initializeProductionEntryFixture({ initialize }: {
  initialize: ({ requestRuntimeModule }: { requestRuntimeModule: RequestProductionRuntimeModule }) => Promise<{ requestId: string }>;
}) {
  const host = new EventTarget();
  const worker = new EventTarget();
  const sendToHost: Worker['postMessage'] = message => {
    host.dispatchEvent(new MessageEvent('message', { data: message }));
  };
  const sendToWorker: Worker['postMessage'] = message => {
    worker.dispatchEvent(new MessageEvent('message', { data: message }));
  };
  const endpoint = Object.assign(worker, {
    postMessage: sendToHost,
  });
  const hostEndpoint = Object.assign(host, {
    postMessage: sendToWorker,
    // Model termination only at the pending message boundary. This does not
    // emulate stopping arbitrary JS/native imports in a real browser Realm.
    terminate: vi.fn(() => worker.dispatchEvent(new Event('messageerror'))),
  });
  const session = createProductionWorkerSession({ worker: hostEndpoint as unknown as Worker, startupTimeoutMs: undefined });
  restorations.push(() => session.dispose());
  const { requestRuntimeModule } = createProductionRuntimeModuleRequester({ endpoint: endpoint as unknown as ProductionRuntimeModuleEndpoint });
  const hostReady = session.run({ operation: async () => undefined });
  const workerReady = startProductionWorkerRuntime({ loadEntry: () => initialize({ requestRuntimeModule }), postMessage: ({ message }) => endpoint.postMessage(message) });
  try {
    // Own both failures before awaiting either. A host rejection must settle
    // even when the simulated Worker is still waiting for an acknowledgement.
    await promiseAllKeyed({ hostReady, workerReady });
  } catch (error) {
    session.dispose();
    throw error;
  }
  return { dispose: () => session.dispose() };
}

export const TEST_ONLY = {
};
