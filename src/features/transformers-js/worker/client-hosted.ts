import { workerProxy } from '@/utils/worker-transport';
import { createProductionWorkerSession } from './production-worker-session';
import { generationCaptureLimitsSchema } from './generation-capture';
import {
  generationCaptureReadRequestSchema,
  generationCaptureReadResultSchema,
  generationCaptureRequestSchema,
  type GenerationCaptureRequest,
  type GenerationCaptureReadRequest,
  type GenerationCaptureReadResult,
  type GenerationCaptureClient,
  type GenerationCaptureClientLifetime,
} from './generation-capture-protocol';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import type {
  TransformersJsWorkerClient,
  WorkerToolDefinition,
  ProgressInfo,
  ModelLoadResult,
  TransformersJsProgressCallback,
  TransformersJsChunkCallback,
  TransformersJsToolCallsCallback,
} from '@/features/transformers-js/types';

function createUnavailableEnvironmentError(): Error {
  return new Error('Transformers.js worker is not available in this environment');
}

export function createTransformersJsWorkerClient(): TransformersJsWorkerClient {
  return createWorkerClientCore({ capture: undefined }).client;
}

/** Recording is opt-in for a synthetic investigation owner, never ordinary chat. */
export function createTransformersJsGenerationCaptureClient({ runId, workerEpoch, limits: rawLimits, getActiveRequest }: {
  runId: string,
  workerEpoch: number,
  limits: GenerationCaptureRequest['limits'],
  getActiveRequest: () => { runId: string; requestId: string } | undefined,
}): GenerationCaptureClient {
  const identity = generationCaptureReadRequestSchema.parse({ runId, workerEpoch });
  const limits = generationCaptureLimitsSchema.parse(rawLimits);
  const issuedCalls: GenerationCaptureRequest['context'][] = [];
  const loadRequests: Array<{ requestedModelId: string; requestedRevision: string | undefined }> = [];
  const incompleteReasons = new Set<GenerationCaptureClientLifetime['incompleteReasons'][number]>();
  const core = createWorkerClientCore({ capture: {
    loadReceiptOwner: identity,
    createRequest() {
      // Read the owner once, before startup/session awaits. A tool loop may
      // issue several calls for one Provider request, each with its own ID.
      if (issuedCalls.length >= limits.maxCalls) {
        incompleteReasons.add('call-limit');
        return undefined;
      }
      try {
        const active = getActiveRequest();
        if (active === undefined) {
          incompleteReasons.add('request-unavailable');
          return undefined;
        }
        const parsed = generationCaptureRequestSchema.safeParse({
          context: { ...identity, runId: active.runId, requestId: active.requestId, generationCallId: issuedCalls.length + 1 },
          limits,
        });
        if (!parsed.success || parsed.data.context.runId !== identity.runId) {
          incompleteReasons.add('request-invalid');
          return undefined;
        }
        issuedCalls.push({ ...parsed.data.context });
        return parsed.data;
      } catch {
        // No diagnostic getter/schema failure may reject actual generation.
        incompleteReasons.add('request-invalid');
        return undefined;
      }
    },
    recordLoad({ modelId, revision }) {
      if (loadRequests.length >= limits.maxCalls) {
        incompleteReasons.add('load-limit');
      } else if (modelId.length > 256 || (revision !== undefined && revision.length > 128)) {
        incompleteReasons.add('load-identity-limit');
      } else {
        // These are requested identities, not proof of resolved revision or
        // successful Load. Do not wrap Load settlement just to record them.
        loadRequests.push({ requestedModelId: modelId, requestedRevision: revision });
      }
    },
  } });
  return {
    client: core.client,
    async takeGenerationCapture(): Promise<GenerationCaptureReadResult> {
      // The coordinator calls this after all Provider requests, not between
      // turns or before propagating a generation error. Never drain or retry.
      const parsed = generationCaptureReadResultSchema.safeParse(await core.takeGenerationCapture({ identity }));
      if (!parsed.success) throw new Error('Invalid generation capture response');
      switch (parsed.data.status) {
      case 'captured': {
        const { capture } = parsed.data;
        if (capture.runId !== identity.runId || capture.workerEpoch !== identity.workerEpoch
          || !generationCaptureLimitsSchema.keyof().options.every(key => capture.limits[key] === limits[key])) {
          throw new Error('Invalid generation capture response');
        }
        break;
      }
      case 'not-started': case 'invalid-context': case 'wrong-run': case 'busy': case 'already-taken': break;
      default: {
        const _ex: never = parsed.data;
        throw new Error(`Unhandled generation capture status: ${String(_ex)}`);
      }
      }
      return parsed.data;
    },
    getCaptureLifetime() {
      return {
        ...identity,
        session: core.isActive() ? 'active' as const : 'inactive' as const,
        issuedCalls: issuedCalls.map(context => ({ ...context })),
        loadRequests: loadRequests.map(request => ({ ...request })),
        incompleteReasons: [...incompleteReasons],
      };
    },
  };
}

function createWorkerClientCore({ capture }: {
  capture: {
    loadReceiptOwner: GenerationCaptureReadRequest,
    createRequest(): GenerationCaptureRequest | undefined,
    recordLoad({ modelId, revision }: { modelId: string; revision: string | undefined }): void,
  } | undefined,
}): {
  client: TransformersJsWorkerClient,
  isActive(): boolean,
  takeGenerationCapture({ identity }: { identity: GenerationCaptureReadRequest }): Promise<GenerationCaptureReadResult>,
} {
  if (typeof Worker === 'undefined') {
    const client: TransformersJsWorkerClient = {
      async loadDownloadedModel({ modelId: _modelId, revision: _revision, progressCallback: _progressCallback }) {
        throw createUnavailableEnvironmentError();
      },
      async unloadModel() {
        throw createUnavailableEnvironmentError();
      },
      async interrupt() {
        throw createUnavailableEnvironmentError();
      },
      async resetCache() {
        throw createUnavailableEnvironmentError();
      },
      async generateText({ messages: _messages, onChunk: _onChunk, onToolCalls: _onToolCalls, params: _params, tools: _tools }) {
        throw createUnavailableEnvironmentError();
      },
      async dispose() {
      },
    };
    return {
      client,
      isActive: () => false,
      async takeGenerationCapture() {
        throw createUnavailableEnvironmentError();
      },
    };
  }

  const worker = new Worker(
    new URL('./bootstrap.ts', import.meta.url),
    { type: 'module' },
  );

  const session = createProductionWorkerSession({ worker, startupTimeoutMs: undefined });
  const client: TransformersJsWorkerClient = {
    async loadDownloadedModel({ modelId, revision, progressCallback }: {
      modelId: string,
      revision?: string,
      progressCallback: TransformersJsProgressCallback,
    }): Promise<ModelLoadResult> {
      capture?.recordLoad({ modelId, revision });
      return session.run({ operation: ({ remote }) => remote.loadDownloadedModel(
        modelId, revision,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
        workerProxy({ value: (info: ProgressInfo) => {
          if (session.isActive()) return progressCallback({ info });
        } }),
        ...(capture === undefined ? [] : [capture.loadReceiptOwner]),
      ) });
    },
    async unloadModel(): Promise<void> {
      return session.run({ operation: ({ remote }) => remote.unloadModel() });
    },
    async interrupt(): Promise<void> {
      return session.run({ operation: ({ remote }) => remote.interrupt() });
    },
    async resetCache(): Promise<void> {
      return session.run({ operation: ({ remote }) => remote.resetCache() });
    },
    async generateText({ messages, onChunk, onToolCalls, params, tools, continuationOwner }: {
      messages: ChatMessage[],
      onChunk: TransformersJsChunkCallback,
      onToolCalls: TransformersJsToolCallsCallback,
      params?: LmParameters,
      tools?: WorkerToolDefinition[],
      continuationOwner?: string,
    }): Promise<void> {
      const request = capture?.createRequest();
      let acceptingCallbacks = true;
      try {
        return await session.run({ operation: ({ remote }) => remote.generateText(
          messages,
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
          workerProxy({ value: (chunk: string) => {
            if (acceptingCallbacks && session.isActive()) return onChunk({ chunk });
          } }),
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback is a positional remote boundary.
          workerProxy({ value: (toolCalls: ToolCall[]) => {
            if (acceptingCallbacks && session.isActive()) return onToolCalls({ toolCalls });
          } }),
          params,
          tools,
          request,
          continuationOwner,
        ) });
      } finally {
        // A failed or disposed RPC cannot deliver into a later request, even
        // when its callback MessagePort still has queued messages.
        acceptingCallbacks = false;
      }
    },
    async dispose(): Promise<void> {
      session.dispose();
    },
  };
  return {
    client,
    isActive: session.isActive,
    takeGenerationCapture({ identity }) {
      return session.run<GenerationCaptureReadResult>({ operation: ({ remote }) => remote.takeGenerationCapture(identity) });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
