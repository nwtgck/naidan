/* eslint-disable no-restricted-imports -- Dedicated verification worker intentionally imports the Transformers.js runtime directly. */
import {
  AutoConfig,
  AutoModelForCausalLM,
  AutoModelForImageTextToText,
  env,
} from '@huggingface/transformers';
import type {
  DownloadVerificationModelArtifactRequestObservation,
  DownloadVerificationModelArtifactRequestWorker,
} from '@/features/transformers-js/download-verification/types';
import {
  createModelArtifactRequestBarrier,
  huggingFaceResolveArtifactRequest,
  type ModelArtifactRequestBarrier,
} from '@/features/transformers-js/download-verification/model-artifact-request-worker/request-barrier';
import {
  normalizeTransformersJsProductionModelId,
  selectTransformersJsProductionAutoClass,
} from '@/features/transformers-js/production-routing';
import {
  configureHostedTransformersRuntime,
  isHuggingFaceModelArtifactUrl,
} from '@/features/transformers-js/runtime/configure-hosted-runtime';
import type {
  TransformersJsProductionInvestigationAutoClass,
  TransformersJsProductionInvestigationCandidate,
} from '@/features/transformers-js/types';
import { exposeWorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { sanitizeDiagnosticText } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';

const OBSERVATION_QUIESCENCE_MS = 500;
const OBSERVATION_TIMEOUT_MS = 10_000;

function requestUrl({ input }: { input: RequestInfo | URL }): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function serializeError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeDiagnosticText({ value: error.message }),
    };
  }
  return {
    name: 'Error',
    message: sanitizeDiagnosticText({ value: String(error) }),
  };
}

async function loadProductionModel({
  autoClass,
  modelId,
  revision,
  candidate,
}: {
  autoClass: TransformersJsProductionInvestigationAutoClass,
  modelId: string,
  revision: string,
  candidate: TransformersJsProductionInvestigationCandidate,
}): Promise<unknown> {
  const options = {
    revision,
    device: candidate.device,
    dtype: candidate.dtype,
    silent: true,
  };
  switch (autoClass) {
  case 'AutoModelForCausalLM':
    return await AutoModelForCausalLM.from_pretrained(modelId, options);
  case 'AutoModelForImageTextToText':
    return await AutoModelForImageTextToText.from_pretrained(modelId, options);
  default: {
    const _ex: never = autoClass;
    throw new Error(`Unhandled production Auto class: ${_ex}`);
  }
  }
}

const originalFetch = self.fetch;
const { runtimeFetch } = configureHostedTransformersRuntime({
  env,
  workerLocationUrl: self.location.href,
  environment: import.meta.env.DEV ? 'development' : 'production',
  userAgent: navigator.userAgent,
  vendor: navigator.vendor,
  hardwareConcurrency: navigator.hardwareConcurrency,
  originalFetch,
  createDecompressionStream: () => new DecompressionStream('gzip'),
});

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = false;
env.useCustomCache = false;

type ObservationLifetime =
  | { kind: 'idle' }
  | { kind: 'observing'; barrier: ModelArtifactRequestBarrier }
  | { kind: 'retired' };
let lifetime: ObservationLifetime = { kind: 'idle' };
// Never reject abandoned parallel Transformers.js branches just to unwind them.
// The one-shot worker's physical termination releases these pending operations.
const inactiveFetch = new Promise<Response>(() => undefined);
const interceptedFetch: typeof fetch = async (input, init) => {
  switch (lifetime.kind) {
  case 'idle':
  case 'retired': return await inactiveFetch;
  case 'observing': break;
  default: {
    const exhaustive: never = lifetime;
    throw new Error(`Unhandled artifact observation lifetime: ${String(exhaustive)}`);
  }
  }
  const url = requestUrl({ input });
  if (isHuggingFaceModelArtifactUrl({ url })) {
    const request = huggingFaceResolveArtifactRequest({ url });
    if (request === undefined) {
      throw new Error('Could not derive a sanitized repository-relative Transformers.js model artifact request');
    }
    return await lifetime.barrier.observe({ request });
  }
  return await runtimeFetch(input, {
    ...init,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
};
// Dynamic lookups and previously captured references share the same terminal gate.
// Never restore network authority between RPC settlement and host termination.
self.fetch = interceptedFetch;
env.fetch = interceptedFetch;

const workerApi: WorkerServerApi<DownloadVerificationModelArtifactRequestWorker> = {
  async observeModelArtifactRequests({
    modelId,
    revision,
    candidate,
  }): Promise<DownloadVerificationModelArtifactRequestObservation> {
    switch (lifetime.kind) {
    case 'idle': break;
    case 'observing':
    case 'retired':
      throw new Error('Model artifact request observation worker can only be used once');
    default: {
      const exhaustive: never = lifetime;
      throw new Error(`Unhandled artifact observation lifetime: ${String(exhaustive)}`);
    }
    }
    const cleanModelId = normalizeTransformersJsProductionModelId({ modelId });
    const barrier = createModelArtifactRequestBarrier({ quiescenceMs: OBSERVATION_QUIESCENCE_MS });
    lifetime = { kind: 'observing', barrier };

    type LoadOutcome =
      | { kind: 'loaded' }
      | { kind: 'failed'; error: unknown };
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
      timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), OBSERVATION_TIMEOUT_MS);
    });

    try {
      // Route from actual bounded metadata under the same credential-free fetch
      // and total observation deadline; never invent a class when it is unknown.
      const metadata = await Promise.race([
        AutoConfig.from_pretrained(cleanModelId, { revision }).then(config => ({ kind: 'config' as const, config })),
        timeout,
      ]);
      switch (metadata.kind) {
      case 'config': break;
      case 'timeout': throw new Error('Timed out while reading model configuration for artifact request observation');
      default: {
        const exhaustive: never = metadata;
        throw new Error(`Unhandled artifact observation metadata outcome: ${String(exhaustive)}`);
      }
      }
      const modelType = typeof metadata.config.model_type === 'string' ? metadata.config.model_type : undefined;
      const autoClass = selectTransformersJsProductionAutoClass({ modelId: cleanModelId, modelType });
      const loadOutcome = loadProductionModel({ autoClass, modelId: cleanModelId, revision, candidate }).then<LoadOutcome, LoadOutcome>(
        () => ({ kind: 'loaded' }), error => ({ kind: 'failed', error }),
      );
      const outcome = await Promise.race([
        barrier.waitForQuiescence().then(requests => ({ kind: 'observed' as const, requests })),
        loadOutcome,
        timeout,
      ]);

      switch (outcome.kind) {
      case 'observed': {
        // Keep the real Transformers.js load suspended on the held artifact fetches.
        // Rejecting those fetches to unwind from_pretrained() can leave parallel
        // internal promise rejections unhandled. The remote observation can return
        // while the load remains pending; the client immediately terminates this
        // dedicated worker after receiving the result.
        return {
          modelId: cleanModelId,
          revision,
          autoClass,
          candidate,
          status: 'observed',
          observationMethod: 'held-model-artifact-fetch-quiescence',
          quiescenceMs: OBSERVATION_QUIESCENCE_MS,
          timeoutMs: OBSERVATION_TIMEOUT_MS,
          paths: [...new Set(outcome.requests.map(request => request.path))].sort((a, b) => a.localeCompare(b)),
          requests: outcome.requests,
          error: undefined,
        };
      }
      case 'failed':
        return {
          modelId: cleanModelId,
          revision,
          autoClass,
          candidate,
          status: 'failed',
          observationMethod: 'held-model-artifact-fetch-quiescence',
          quiescenceMs: OBSERVATION_QUIESCENCE_MS,
          timeoutMs: OBSERVATION_TIMEOUT_MS,
          paths: [],
          requests: [],
          error: serializeError({ error: outcome.error }),
        };
      case 'loaded':
        return {
          modelId: cleanModelId,
          revision,
          autoClass,
          candidate,
          status: 'failed',
          observationMethod: 'held-model-artifact-fetch-quiescence',
          quiescenceMs: OBSERVATION_QUIESCENCE_MS,
          timeoutMs: OBSERVATION_TIMEOUT_MS,
          paths: [],
          requests: [],
          error: {
            name: 'UnexpectedModelLoad',
            message: 'Transformers.js completed model loading without an intercepted model artifact request',
          },
        };
      case 'timeout': {
        const error = new Error('Timed out while waiting for Transformers.js model artifact requests');
        // As with the observed path, do not reject held artifact fetches just to
        // unwind the real Transformers.js load. Returning lets the client dispose
        // this dedicated worker without creating synthetic unhandled rejections.
        return {
          modelId: cleanModelId,
          revision,
          autoClass,
          candidate,
          status: 'failed',
          observationMethod: 'held-model-artifact-fetch-quiescence',
          quiescenceMs: OBSERVATION_QUIESCENCE_MS,
          timeoutMs: OBSERVATION_TIMEOUT_MS,
          paths: [],
          requests: [],
          error: serializeError({ error }),
        };
      }
      default: {
        const _ex: never = outcome;
        throw new Error(`Unhandled model artifact request observation outcome: ${String(_ex)}`);
      }
      }
    } finally {
      lifetime = { kind: 'retired' };
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      barrier.dispose();
    }
  },
};

exposeWorkerRemote<DownloadVerificationModelArtifactRequestWorker>({
  api: workerApi,
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  OBSERVATION_QUIESCENCE_MS,
  OBSERVATION_TIMEOUT_MS,
};
