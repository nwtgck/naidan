import { z } from 'zod';
import { rawRuntime, type ReplayOptions } from './model-runtime-input-helpers';
import { readModelFixture } from './model-runtime-fixture';
import { createRequiredDownloadedResourceOperation } from '@/features/transformers-js/runtime/required-downloaded-resource-operation';
import { createDownloadedModelCacheScope } from '@/features/transformers-js/runtime/downloaded-model-cache';
import { createLoadDiagnosticLedger, createLoadDiagnosticOperation } from '@/features/transformers-js/worker/load-diagnostics';

const count = z.number().int().nonnegative().safe();
export const modelLoadAllocationEvidenceSchema = z.object({
  format: z.literal('model-load-allocation-observation-v1'), modelId: z.string(), metadataRevision: z.string(),
  source: z.literal('selected-browser-load-diagnostics-and-cache-observations'),
  success: z.object({
    nativeCaptureSha256: z.string().regex(/^[a-f0-9]{64}$/u), cacheRevision: z.string(), wholeFileIdentity: z.literal('not-verified'),
    candidate: z.object({ device: z.literal('webgpu'), dtype: z.literal('q4f16') }).strict(),
    resources: z.array(z.object({ path: z.string().regex(/^onnx\/[^/]+$/u), bytes: count.positive(), successfulAllocations: z.literal(1) }).strict()).min(1),
    successfulAllocationBytes: count, returnedReadBufferBytes: count, ortEntry: z.literal('after-all-required-reads'), load: z.literal('fulfilled'), nativeCalls: count,
  }).strict(),
  missingCache: z.object({ nativeCaptureSha256: z.string().regex(/^[a-f0-9]{64}$/u), fileCount: z.literal(0), load: z.literal('rejected-before-candidate'),
    weightReads: z.literal(0), ortEntries: z.literal(0), modelDownloads: z.literal(0),
  }).strict(),
  limits: z.string(),
}).strict();

/** Actual Vite bundle/AutoModel/getModelFile/reader with explicitly supplied test bodies. */
export async function createModelLoadAllocationRuntime({ modelId, paths, response }: {
  modelId: string; paths: readonly string[];
  response: ({ path }: { path: string }) => Response | Promise<Response>;
}) {
  const archive = readModelFixture({ modelId });
  const raw = await rawRuntime({ archive, bodyPaths: [...paths] });
  const original = raw.runtime.env.customCache;
  const scope = createDownloadedModelCacheScope({ modelId, revision: archive.summary.revision });
  const owned = createRequiredDownloadedResourceOperation({
    modelId, revision: archive.summary.revision, requiredPaths: paths, workerLocationUrl: 'http://localhost/assets/worker.js',
    modelCache: {
      ...original,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Third-party customCache callback boundary.
      async match(request) {
        const resolution = scope.resolve({ request });
        switch (resolution.kind) {
        case 'admitted': break;
        case 'outside-scope':
        case 'unsupported-method': return undefined;
        default: { const _ex: never = resolution; throw new Error(`Unhandled scope ${_ex}`); }
        }
        const matched = await original.match(request);
        const url = typeof request === 'string' ? request : request.url;
        const path = url.split(`/resolve/${archive.summary.revision}/`)[1];
        if (path === undefined || !paths.includes(path)) return matched;
        // The existing raw harness's one-byte response is never consumed. The
        // caller explicitly owns the replacement Content-Length/body contract.
        await matched?.body?.cancel();
        return response({ path });
      },
    }, cacheOnlyFetch: raw.guardedFetch,
  });
  raw.runtime.env.customCache = owned.cache;
  raw.runtime.env.fetch = owned.fetch;
  const owner = { runId: 'synthetic-allocation-control', workerEpoch: 1 };
  const ledger = createLoadDiagnosticLedger({ owner });
  const recording = createLoadDiagnosticOperation({ owner, loadOrdinal: 1, resourceNames: 'public-repository', sink: ({ packet }) => ledger.observe({ packet }) });
  raw.runtime.env.naidanModelLoadObserver = recording.beginCandidate({ device: 'webgpu', dtype: 'q4f16', revision: archive.summary.revision });
  raw.gate.resolve();
  const options: ReplayOptions = { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined, device: 'webgpu', dtype: 'q4f16' };
  return {
    raw, owned, archive, options,
    registry: () => raw.runtime.ModelRegistry.get_model_files(modelId, { ...options, config: JSON.parse(new TextDecoder().decode(archive.files.get('config.json'))) }),
    load: () => raw.runtime.AutoModelForCausalLM.from_pretrained(modelId, options),
    diagnostics: () => ledger.snapshot({ expectedLoadCount: 0 }),
    async close() {
      try {
        await owned.close();
      } finally {
        raw.restoreSessionSpy();
      }
    },
  };
}

/** Refuse every large numeric request before native allocation, never fake success. */
export function trapLargeModelAllocation({ failure }: { failure: RangeError }) {
  const original = globalThis.Uint8Array;
  const originalBuffer = globalThis.ArrayBuffer;
  const originalMemory = WebAssembly.Memory;
  const requests: Array<{ bytes: number; boundary: 'readResponse' | 'unexpected' }> = [];
  const refuse = ({ bytes }: { bytes: number }): never => {
    requests.push({ bytes, boundary: 'unexpected' });
    throw failure;
  };
  globalThis.ArrayBuffer = new Proxy(originalBuffer, {
    construct(target, args, newTarget) {
      if (typeof args[0] === 'number' && args[0] > 1024 * 1024) return refuse({ bytes: args[0] });
      return Reflect.construct(target, args, newTarget);
    },
  });
  WebAssembly.Memory = new Proxy(originalMemory, {
    construct(target, args, newTarget) {
      const descriptor = z.object({ initial: z.number() }).passthrough().parse(args[0]);
      if (descriptor.initial > 16) return refuse({ bytes: descriptor.initial * 65536 });
      return Reflect.construct(target, args, newTarget);
    },
  });
  globalThis.Uint8Array = new Proxy(original, {
    construct(target, args, newTarget) {
      if (typeof args[0] === 'number' && args[0] > 1024 * 1024) {
        const stack = new Error().stack ?? '';
        requests.push({ bytes: args[0], boundary: stack.includes('readResponse') && stack.includes('transformers-js-fixes.mjs') ? 'readResponse' : 'unexpected' });
        throw failure;
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  return { requests, restore() {
    globalThis.Uint8Array = original; globalThis.ArrayBuffer = originalBuffer; WebAssembly.Memory = originalMemory;
  } };
}

export const TEST_ONLY = {
};
