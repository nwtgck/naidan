/* eslint-disable no-restricted-imports -- Dedicated online metadata Worker; never imported by Production Load. */
import { AutoConfig, AutoProcessor, AutoTokenizer, env } from '@huggingface/transformers';
import { exposeWorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { prepareRuntimeMetadata } from '@/features/transformers-js/download-verification/download-worker/prepare-runtime-metadata';
import { createMemoryMetadataStorage } from '@/features/transformers-js/download-verification/download-worker/memory-metadata-storage';
import { configureHostedTransformersRuntime } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { createHostedTransformersModelFetch } from '@/features/transformers-js/runtime/model-fetch';
import { collectReplayMetadata, type InvestigationReplayMetadataSummary } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';
import { createFreshMetadataTransport } from './transport';
import { classifyFreshMetadataFailure } from './failure-category';
import { freshMetadataRequestSchema, freshMetadataResultSchema, FRESH_METADATA_TIMEOUT_MS, type FreshMetadataSummary, type FreshMetadataWorker } from './types';

const originalFetch = self.fetch;
self.fetch = async () => {
  throw new Error('Fresh metadata requires an active bounded operation');
};
let state: 'unused' | 'used' = 'unused';

const api: WorkerServerApi<FreshMetadataWorker> = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Remote Worker method with a proxied callback.
  async run(rawInput, onObservation) {
    const input = freshMetadataRequestSchema.parse(rawInput);
    switch (state) {
    case 'unused': break;
    case 'used': throw new Error('Fresh metadata requires a new Worker for each operation');
    default: {
      const _ex: never = state;
      throw new Error(`Unknown fresh metadata Worker state: ${_ex}`);
    }
    }
    state = 'used';
    const { modelId, revision, maximumBytes, repositoryFiles } = input;
    const memory = createMemoryMetadataStorage({ maximumByteLength: maximumBytes });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Fresh metadata deadline exceeded')), FRESH_METADATA_TIMEOUT_MS);
    let summary: FreshMetadataSummary = {
      schemaVersion: 1, modelId, revision, source: 'fresh-network-memory', status: 'running',
      maximumBytes, receivedBytes: 0, requests: [],
      preparationStage: 'worker-initialization',
    };
    let publishedBytes = 0;
    let publishedStates = '';
    // This transport sits below the same model-fetch adapter as Download, so
    // fallback HTTP requests count against the budget too.
    const transport = createFreshMetadataTransport({
      modelId, revision, maximumBytes, originalFetch, signal: abort.signal,
      onObservation: () => {
        summary = { ...summary, ...transport.snapshot() };
        // Report every phase transition, but bound callback volume when fetch
        // supplies tiny chunks. This never delays the final completion signal.
        const states = summary.requests.map(request => `${request.status}:${request.httpStatus ?? ''}`).join('|');
        if (states === publishedStates && summary.receivedBytes - publishedBytes < 256 * 1024) return;
        publishedStates = states;
        publishedBytes = summary.receivedBytes;
        onObservation({ summary });
      },
    });
    let replayMetadata: InvestigationReplayMetadataSummary | undefined;
    let files: Array<{ path: string, blob: Blob }> = [];
    let downloadFetch: typeof fetch | undefined;
    try {
      const { runtimeFetch } = configureHostedTransformersRuntime({
        env, workerLocationUrl: self.location.href, environment: import.meta.env.DEV ? 'development' : 'production',
        userAgent: navigator.userAgent, vendor: navigator.vendor, hardwareConcurrency: navigator.hardwareConcurrency,
        originalFetch: transport.fetch, createDecompressionStream: () => new DecompressionStream('gzip'),
      });
      downloadFetch = createHostedTransformersModelFetch({ runtimeFetch });
      self.fetch = transport.fetch;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = false;
      env.useCustomCache = true;
      const preparation = await prepareRuntimeMetadata({
        modelId, revision, runtime: { AutoConfig, AutoProcessor, AutoTokenizer, env }, downloadFetch,
        storage: memory.storage, maximumByteLength: 32 * 1024 * 1024,
        progressCallback: () => undefined,
        onStage: ({ stage }) => {
          summary = { ...summary, ...transport.snapshot(), preparationStage: stage };
          // Semantic stage changes are published immediately even without HTTP
          // activity, including tokenizer/processor CPU work and storage cleanup.
          onObservation({ summary });
        },
      });
      abort.signal.throwIfAborted();
      summary = { ...summary, ...transport.snapshot(), status: 'prepared', preparation };
      onObservation({ summary });
    } catch (error) {
      // Arbitrary upstream messages/stacks can contain local paths, signed URLs
      // or metadata values. HTTP identity/status evidence is retained separately.
      summary = { ...summary, ...transport.snapshot(), status: abort.signal.aborted ? 'timeout' : 'failed', failureCategory: classifyFreshMetadataFailure({ error }), reason: 'Fresh runtime metadata preparation did not complete; inspect its preparation stage, failure category and HTTP observations.' };
      onObservation({ summary });
    }
    try {
      const prefix = `https://huggingface.co/${modelId}/resolve/${revision}/`;
      const collected = memory.snapshot();
      transport.setConsumer({ next: 'replay-supplement' });
      const supplementFetch = (() => {
        switch (summary.status) {
        case 'prepared': return downloadFetch;
        case 'running':
        case 'failed':
        case 'timeout':
        case 'interrupted':
        case 'not-run': return undefined;
        default: {
          const _ex: never = summary.status;
          throw new Error(`Unknown metadata status: ${_ex}`);
        }
        }
      })();
      await collectReplayMetadata({
        modelId, revision, files: repositoryFiles.map(({ path, size }) => ({ path, size })),
        budgetBytes: maximumBytes, fileTimeoutMs: 15_000, modelAccess: 'public-request',
        localRead: async ({ path }) => collected.get(`${prefix}${path}`),
        remoteFetch: supplementFetch,
        onSnapshot: ({ snapshot }) => {
          // "local" here is this operation's fresh in-memory acquisition, not
          // OPFS. Preserve remote provenance when adapting the shared collector.
          replayMetadata = { ...snapshot.summary, files: snapshot.summary.files.map(file => {
            switch (file.source) {
            case 'local-exact': return { ...file, source: 'remote-exact' as const };
            case 'remote-exact':
            case 'not-read': return file;
            default: {
              const _ex: never = file.source;
              throw new Error(`Unknown replay metadata source: ${_ex}`);
            }
            }
          }) };
          files = snapshot.sidecars;
        },
      });
      summary = { ...summary, ...transport.snapshot() };
      onObservation({ summary });
      return freshMetadataResultSchema.parse({ summary, replayMetadata, files });
    } finally {
      clearTimeout(timer);
      transport.dispose();
      self.fetch = async () => {
        throw new Error('Fresh metadata operation has ended');
      };
      await memory.dispose();
    }
  },
};

exposeWorkerRemote<FreshMetadataWorker>({ api, endpoint: undefined });

export const TEST_ONLY = {
};
