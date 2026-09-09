import type { createOpfsModelCache } from './opfs-model-cache';
import { downloadedModelResourceUrl } from './downloaded-model-resource-url';
import { createDownloadedModelCacheScope } from './downloaded-model-cache';
import { DownloadedModelResourcePlanningError } from './plan-downloaded-model-candidates';

export const REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME = 'RequiredDownloadedResourceCleanupError';
export const REQUIRED_DOWNLOADED_MODEL_RESOURCE_ERROR_NAME = 'RequiredDownloadedModelResourceError';
export const REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_TIMEOUT_MS = 5_000;

export class RequiredDownloadedResourceCleanupError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Downloaded resource cleanup deadline exceeded; the owning Worker must terminate', { cause });
    this.name = REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME;
  }
}

export class RequiredDownloadedModelResourceError extends Error {
  readonly url: string;
  readonly failure: 'missing' | 'io' | 'unplanned';

  constructor({ url, failure, cause }: { url: string, failure: 'missing' | 'io' | 'unplanned', cause: unknown }) {
    super(`Required downloaded model resource ${failure} after complete planning; loadDownloadedModel() MUST NOT fetch model artifacts or try another candidate: ${url}`, { cause });
    this.name = REQUIRED_DOWNLOADED_MODEL_RESOURCE_ERROR_NAME;
    this.url = url;
    this.failure = failure;
  }
}

async function boundedCleanup({ cleanup, cause }: { cleanup: Promise<void>, cause: () => unknown }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RequiredDownloadedResourceCleanupError({ cause: cause() })), REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function disposeRejectedDownloadedRuntime({ dispose, cause }: { dispose: () => Promise<unknown>, cause: unknown }) {
  // Once resource cleanup has expired, report that typed failure immediately so
  // the host can physically terminate the Worker. Disposal is advisory then.
  const disposal = Promise.resolve().then(dispose).then(() => undefined, () => undefined);
  if (cause instanceof RequiredDownloadedResourceCleanupError) return;
  await boundedCleanup({ cleanup: disposal, cause: () => cause });
}

/** One candidate's non-persisted authority over its already checked resources. */
export function createRequiredDownloadedResourceOperation({
  modelId, revision, requiredPaths, workerLocationUrl, modelCache, cacheOnlyFetch,
}: {
  modelId: string,
  revision: string | undefined,
  requiredPaths: readonly string[],
  workerLocationUrl: string,
  modelCache: ReturnType<typeof createOpfsModelCache>,
  cacheOnlyFetch: typeof fetch,
}) {
  const scope = createDownloadedModelCacheScope({ modelId, revision });
  const requiredKeys = new Set(requiredPaths.map(repositoryPath => {
    const request = downloadedModelResourceUrl({ modelId, revision, repositoryPath, workerLocationUrl });
    const resolution = scope.resolve({ request });
    switch (resolution.kind) {
    case 'admitted': return resolution.resourceKey;
    case 'outside-scope':
    case 'unsupported-method':
      throw new DownloadedModelResourcePlanningError({ modelId, revision, details: `Required resource is outside the selected cache scope: ${repositoryPath}` });
    default: {
      const _ex: never = resolution;
      throw new Error(`Unhandled required resource scope ${_ex}`);
    }
    }
  }));
  let failure: RequiredDownloadedModelResourceError | undefined;
  let cleanupFailure: RequiredDownloadedResourceCleanupError | undefined;
  let lifecycle: 'active' | 'closed' = 'active';
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const bodies = new Set<() => Promise<void>>();

  function assertActive() {
    switch (lifecycle) {
    case 'active': return;
    case 'closed': throw new Error('Downloaded resource operation is closed');
    default: {
      const _ex: never = lifecycle;
      throw new Error(`Unhandled downloaded resource lifecycle ${_ex}`);
    }
    }
  }
  function recordFailure({ url, kind, cause }: { url: string, kind: RequiredDownloadedModelResourceError['failure'], cause: unknown }) {
    failure ??= new RequiredDownloadedModelResourceError({ url, failure: kind, cause });
    return failure;
  }
  function assertHealthy() {
    if (cleanupFailure) throw cleanupFailure;
    if (failure) throw failure;
  }
  function resourceUrl({ value }: { value: string }): string {
    const url = new URL(value, workerLocationUrl);
    url.search = ''; url.hash = '';
    // Keep pathname escaping intact: OPFS keys do not decode it. Resolving a
    // relative URL must not alias the local namespace to the HF repository.
    return url.href;
  }
  function assertBodyAllowed({ url, resourceKey }: { url: string, resourceKey: string | undefined }) {
    let pathname: string;
    try {
      // Decode only for artifact detection, never to broaden the allowed keys.
      // An encoded extension cannot hide an unplanned ONNX body.
      pathname = decodeURIComponent(new URL(url).pathname);
    } catch (cause) {
      throw recordFailure({ url, kind: 'unplanned', cause });
    }
    if (/\.onnx(?:_data(?:_\d+)?)?$/iu.test(pathname) && (resourceKey === undefined || !requiredKeys.has(resourceKey))) {
      throw recordFailure({ url, kind: 'unplanned', cause: undefined });
    }
  }
  function track<T>({ operation }: { operation: Promise<T> }): Promise<T> {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }
  async function drain() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }
  function scopedIoFailure({ url, scopeOwnership, cause }: {
    url: string, scopeOwnership: 'owned' | 'outside', cause: unknown,
  }) {
    switch (scopeOwnership) {
    case 'owned': return recordFailure({ url, kind: 'io', cause });
    case 'outside': return cause;
    default: {
      const _ex: never = scopeOwnership;
      throw new Error(`Unhandled resource scope ownership ${_ex}`);
    }
    }
  }
  function observeBody({ response, url, resourceKey, scopeOwnership }: { response: Response, url: string, resourceKey: string | undefined, scopeOwnership: 'owned' | 'outside' }): Response {
    const source = response.body;
    if (!source) return response;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    function bodyFailure({ cause }: { cause: unknown }) {
      return scopedIoFailure({ url, scopeOwnership, cause });
    }
    function releaseReader() {
      try {
        reader?.releaseLock();
      } catch (cause) {
        throw bodyFailure({ cause });
      }
    }
    const cancel = () => {
      cancellation ??= track({ operation: (async () => {
        try {
          if (reader) await reader.cancel();
          else await source.cancel();
        } catch (cause) {
          throw bodyFailure({ cause });
        } finally {
          try {
            releaseReader();
          } finally {
            bodies.delete(cancel);
          }
        }
      })() });
      return cancellation;
    };
    bodies.add(cancel);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          assertActive();
          assertHealthy();
          // The upstream progress prepass may inspect unselected model headers.
          // Only consuming a body grants model bytes to ORT; stop before even
          // acquiring the underlying reader when the complete plan excludes it.
          assertBodyAllowed({ url, resourceKey });
          try {
            reader ??= source.getReader();
          } catch (cause) {
            throw bodyFailure({ cause });
          }
          const result = await track({ operation: (async () => {
            try {
              return await reader!.read();
            } catch (cause) {
              throw bodyFailure({ cause });
            }
          })() });
          assertActive();
          // A concurrent failure also forbids delivering a read that was already
          // in flight. This check does not physically interrupt that native I/O.
          assertHealthy();
          if (result.done) {
            releaseReader();
            bodies.delete(cancel);
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (cause) {
          controller.error(cause);
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  const cache: ReturnType<typeof createOpfsModelCache> = {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Native Cache-compatible boundary.
    match(request) {
      return track({ operation: (async () => {
        assertActive();
        const resolution = scope.resolve({ request });
        let url: string;
        let resourceKey: string | undefined;
        let scopeOwnership: 'owned' | 'outside';
        switch (resolution.kind) {
        case 'unsupported-method': return undefined;
        case 'admitted':
          url = resourceUrl({ value: resolution.url });
          resourceKey = resolution.resourceKey;
          scopeOwnership = 'owned';
          break;
        case 'outside-scope':
          url = resourceUrl({ value: typeof request === 'string' ? request : request.url });
          resourceKey = undefined;
          scopeOwnership = 'outside';
          break;
        default: {
          const _ex: never = resolution;
          throw new Error(`Unhandled cache scope result ${_ex}`);
        }
        }
        const required = resourceKey !== undefined && requiredKeys.has(resourceKey);
        let response: Response | undefined;
        try {
          response = await modelCache.match(request);
        } catch (cause) {
          // Optional absence is normal; native I/O failure is not evidence of
          // absence or candidate incompatibility. A preceding local probe is
          // outside an HF operation and must not poison its exact lookup.
          if (required || (scopeOwnership === 'owned' && !((cause instanceof DOMException || cause instanceof Error) && cause.name === 'NotFoundError'))) {
            throw recordFailure({ url, kind: 'io', cause });
          }
          throw cause;
        }
        if (required && response === undefined) throw recordFailure({ url, kind: 'missing', cause: undefined });
        switch (lifecycle) {
        case 'closed':
          try {
            await response?.body?.cancel();
          } catch (cause) {
            throw scopedIoFailure({ url, scopeOwnership, cause });
          }
          throw new Error('Downloaded resource response arrived after operation closure');
        case 'active': break;
        default: {
          const _ex: never = lifecycle;
          throw new Error(`Unhandled downloaded resource lifecycle ${_ex}`);
        }
        }
        return response === undefined ? undefined : observeBody({ response, url, resourceKey, scopeOwnership });
      })() });
    },
    async put() {
      throw new Error('Read-only OPFS model cache MUST NOT be written during model loading');
    },
  };
  const guardedFetch: typeof fetch = async (input, init) => {
    assertActive();
    const url = resourceUrl({ value: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url });
    const resolution = scope.resolve({ request: input instanceof URL ? input.href : input });
    if (resolution.kind === 'admitted' && requiredKeys.has(resolution.resourceKey)) throw recordFailure({ url, kind: 'missing', cause: undefined });
    return cacheOnlyFetch(input, init);
  };
  return {
    cache, fetch: guardedFetch, assertHealthy,
    close() {
      closing ??= (async () => {
        lifecycle = 'closed';
        const cleanup = (async () => {
          await Promise.allSettled([...bodies].map(cancel => cancel()));
          await drain();
        })();
        try {
          await boundedCleanup({ cleanup, cause: () => failure });
        } catch (error) {
          if (error instanceof RequiredDownloadedResourceCleanupError) cleanupFailure = error;
          throw error;
        }
      })();
      return closing;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
