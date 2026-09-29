import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { createDownloadedModelReadOnlyCache } from '@/features/transformers-js/runtime/downloaded-model-cache';
import { createDownloadedModelWorkerFetch } from '@/features/transformers-js/runtime/offline-worker-fetch';
import type { OpfsModelCacheMatchObservation } from '@/features/transformers-js/runtime/opfs-model-cache';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';

export const WEB_BUNDLE_SHA256 = '25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff';

export function digest({ bytes }: { bytes: Uint8Array }): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type RawModel = ReturnType<typeof readModelFixture>;
export interface ReplayTokenizer {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Exact positional external Transformers.js tokenizer API.
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Exact positional external Transformers.js template API.
  apply_chat_template(messages: Array<{ role: string, content: string }>, options: { tokenize: false, add_generation_prompt: boolean }): string;
}
export interface ReplayProcessor {
  tokenizer: ReplayTokenizer;
  image_processor?: { constructor: { name: string } };
  feature_extractor?: { constructor: { name: string } };
  constructor: { name: string };
  apply_chat_template: ReplayTokenizer['apply_chat_template'];
}
export type ReplayOptions = { revision: string, local_files_only: true, progress_callback: () => void, device?: 'webgpu', dtype?: 'q4f16' | 'q4' };
export interface ReplayRuntime {
  env: Record<string, unknown> & { customCache: ReturnType<typeof createDownloadedModelReadOnlyCache> };
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native dynamic import keeps the external TJS positional API.
  AutoTokenizer: { from_pretrained(modelId: string, options: ReplayOptions): Promise<ReplayTokenizer> };
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native dynamic import keeps the external TJS positional API.
  AutoProcessor: { from_pretrained(modelId: string, options: ReplayOptions): Promise<ReplayProcessor> };
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native dynamic import keeps the external TJS positional API.
  AutoModelForCausalLM: { from_pretrained(modelId: string, options: ReplayOptions): Promise<{ dispose(): Promise<void> }> };
  AutoModelForImageTextToText: ReplayRuntime['AutoModelForCausalLM'];
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native dynamic import keeps the external TJS positional API.
  ModelRegistry: { get_model_files(modelId: string, options: ReplayOptions & { config: Record<string, unknown> }): Promise<string[]> };
}

export async function rawRuntime({ archive, bodyPaths }: { archive: RawModel, bodyPaths: string[] }) {
  // Build before installing the browser-like globals used only for evaluation.
  const runtimeArtifact = await getProductionTransformersArtifact();
  if (runtimeArtifact.originalBundleSha256 !== WEB_BUNDLE_SHA256) throw new Error('Unexpected installed Transformers.js web bundle');
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error('Transport forbidden in checked-in model replay');
  });
  const guardedFetch = vi.fn(createDownloadedModelWorkerFetch({ originalFetch: transport, workerLocationUrl: 'http://localhost/assets/worker.js', environment: 'production', userAgent: 'Vitest', vendor: '' }));
  vi.stubGlobal('fetch', guardedFetch);
  // Real urlToPath uses self.location, as in the hosted Worker. Supplying only
  // navigator in Node would accidentally exercise its malformed-URL fallback.
  vi.stubGlobal('self', { location: new URL('http://localhost/assets/worker.js') });
  const bundleUrl = new URL(runtimeArtifact.moduleUrl);
  // The native ORT import and spy use the exact ESM class imported by this web
  // bundle. No ORT session executes: one-byte bodies only drain file selection.
  const ortUrl = runtimeArtifact.ortWebGpuUrl;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Exact external ORT overload boundary, spied without invoking native create.
  const ort = await import(/* @vite-ignore */ ortUrl) as { InferenceSession: { create(...args: unknown[]): Promise<unknown> } };
  const released = vi.fn(async () => undefined);
  const sessions = vi.spyOn(ort.InferenceSession, 'create').mockImplementation(async () => ({ inputNames: [], outputNames: [], release: released }));
  const mutations = vi.fn();
  const reads: string[] = [];
  const base = `models/huggingface.co/${archive.summary.modelId}/resolve/${archive.summary.revision}/`;
  const blobs = new Map<string, Blob>();
  for (const [path, bytes] of archive.files) {
    const blob = new Blob([Uint8Array.from(bytes)]);
    blobs.set(`${base}${path}`, blob);
    blobs.set(`${base}.${path}.complete`, new Blob([]));
  }
  const directory = ({ prefix }: { prefix: string }): FileSystemDirectoryHandle => ({
    // eslint-disable-next-line local-rules-named-args/require-named-args -- FileSystemDirectoryHandle browser API signature.
    getDirectoryHandle: async (name: string, options: FileSystemGetDirectoryOptions) => {
      if (options?.create) {
        mutations(); throw new Error('Directory write forbidden');
      }
      return directory({ prefix: `${prefix}${name}/` });
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- FileSystemDirectoryHandle browser API signature.
    getFileHandle: async (name: string, options: FileSystemGetFileOptions) => {
      if (options?.create) {
        mutations(); throw new Error('File write forbidden');
      }
      const path = `${prefix}${name}`;
      reads.push(path);
      const blob = blobs.get(path);
      if (blob === undefined) throw new DOMException('Missing raw fixture file', 'NotFoundError');
      return { getFile: async () => blob, createWritable: () => {
        mutations(); throw new Error('Writer forbidden');
      } };
    },
    removeEntry: () => {
      mutations(); throw new Error('Delete forbidden');
    },
  } as unknown as FileSystemDirectoryHandle);
  vi.stubGlobal('navigator', { userAgent: 'Vitest', vendor: '', gpu: {}, storage: { getDirectory: async () => directory({ prefix: '' }) } });
  const actualProcess = globalThis.process;
  vi.stubGlobal('process', { ...actualProcess, release: { ...actualProcess.release, name: 'browser-test' } });
  bundleUrl.searchParams.set('raw-model-replay', crypto.randomUUID());
  let runtime: ReplayRuntime;
  try {
    runtime = await importProductionTransformersArtifact({ moduleUrl: bundleUrl.href }) as ReplayRuntime;
  } finally {
    vi.stubGlobal('process', actualProcess);
  }
  const observations: OpfsModelCacheMatchObservation[] = [];
  const cache = createDownloadedModelReadOnlyCache({ modelId: archive.summary.modelId, revision: archive.summary.revision, onMatchObservation: ({ observation }) => observations.push(observation) });
  const gate = Promise.withResolvers<void>();
  const requests: string[] = [];
  const unknownRequests: string[] = [];
  const bodyReads: string[] = [];
  const allowedMetadata = new Set<string>(archive.summary.files.map(file => file.path));
  Object.assign(runtime.env, {
    allowLocalModels: true, allowRemoteModels: false, useBrowserCache: false, useCustomCache: true, useWasmCache: false, fetch: guardedFetch,
    customCache: {
      ...cache,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- TJS customCache external positional callback.
      async match(request: string | Request) {
        const url = typeof request === 'string' ? request : request.url;
        const marker = `${archive.summary.modelId}/`;
        const offset = url.indexOf(marker);
        let path = offset < 0 ? '' : url.slice(offset + marker.length);
        if (path.startsWith('resolve/')) {
          const [, revision, ...parts] = path.split('/');
          path = parts.join('/');
          if (revision !== archive.summary.revision && !(revision === 'main' && ['tokenizer_config.json', 'preprocessor_config.json'].includes(path))) {
            unknownRequests.push(url); throw new Error('Unexpected raw replay revision');
          }
        }
        requests.push(path);
        if (bodyPaths.includes(path)) {
          await gate.promise;
          return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
            bodyReads.push(path); controller.enqueue(new Uint8Array([1])); controller.close();
          } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '1' } });
        }
        if (offset < 0 || !allowedMetadata.has(path)) {
          unknownRequests.push(url); throw new Error('Uncaptured raw replay request');
        }
        return cache.match(request);
      },
      async put() {
        mutations(); throw new Error('Cache put forbidden');
      },
    },
  });
  return { runtime, cache, transport, guardedFetch, mutations, reads, observations, sessions, released, gate, requests, unknownRequests, bodyReads, runtimeArtifact, restoreSessionSpy: () => sessions.mockRestore() };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
