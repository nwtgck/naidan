import { expectedDecodedResponseByteLength, fullResourceResponseError } from '@/features/transformers-js/utils';
import { isModelWeightFileName } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import type { RuntimeMetadataStorage } from './metadata-storage';

// This bounds resource cleanup, not tokenizer execution or the entire Download.
// A timeout never grants readiness; the caller must retire the owning Worker.
export const RUNTIME_METADATA_CLEANUP_TIMEOUT_MS = 1_000;

const presencePaths = new Set(['tokenizer_config.json', 'preprocessor_config.json']);

export function createRuntimeMetadataOperation({ modelId, revision, downloadFetch, storage, maximumByteLength }: {
  modelId: string,
  revision: string,
  downloadFetch: typeof fetch,
  storage: RuntimeMetadataStorage,
  maximumByteLength: number,
}) {
  if (!/^[a-f0-9]{40}$/iu.test(revision) || !/^[\w.-]+\/[\w.-]+$/u.test(modelId)) {
    throw new Error('Invalid immutable metadata operation identity');
  }
  let state: 'active' | 'finishing' | 'closed' = 'active';
  let failure: { error: unknown } | undefined;
  const failed = Promise.withResolvers<void>();
  const pending = new Set<Promise<unknown>>();
  const writes = new Map<string, Promise<void>>();
  const required = new Map<string, number | undefined>();
  const leases = new Set<{ cancel(): Promise<void> }>();
  const cancellations = new Set<Promise<void>>();
  const cancelled = new WeakMap<{ cancel(): Promise<void> }, Promise<void>>();
  let draining = false;

  function fail({ error }: { error: unknown }): unknown {
    if (failure === undefined) {
      failure = { error }; failed.resolve();
    }
    return failure.error;
  }
  function check() {
    if (failure !== undefined) throw failure.error;
    switch (state) {
    case 'active':
    case 'finishing': return;
    case 'closed': throw new Error('Metadata operation is closed');
    default: { const exhaustive: never = state; throw new Error(`Unknown operation state: ${exhaustive}`); }
    }
  }
  function assertActive() {
    switch (state) {
    case 'active': return;
    case 'finishing':
    case 'closed': throw new Error('Metadata operation is not active');
    default: { const exhaustive: never = state; throw new Error(`Unknown operation state: ${exhaustive}`); }
    }
  }
  function cancelLease({ lease }: { lease: { cancel(): Promise<void> } }): Promise<void> {
    const previous = cancelled.get(lease);
    if (previous !== undefined) return previous;
    const task = Promise.resolve().then(() => lease.cancel()).catch(error => {
      throw fail({ error });
    }).finally(() => {
      cancellations.delete(task); leases.delete(lease);
    });
    cancelled.set(lease, task);
    cancellations.add(task);
    void task.catch(() => undefined);
    return task;
  }
  function ownLease({ lease }: { lease: { cancel(): Promise<void> } }) {
    leases.add(lease);
    // Responses resolving during cleanup or after its deadline still belong to
    // this operation. Do not drop them with an earlier cleanup snapshot.
    if (draining) void cancelLease({ lease }).catch(() => undefined);
  }
  function tracked<T>({ run }: { run: () => Promise<T> | T }): Promise<T> {
    try {
      assertActive();
    } catch (error) {
      return Promise.reject(fail({ error }));
    }
    const task = Promise.resolve().then(() => {
      check(); return run();
    }).catch(error => {
      throw fail({ error });
    }).finally(() => pending.delete(task));
    pending.add(task);
    // The upstream caller may ignore/catch this Promise. The operation retains
    // the failure independently and finish still rejects.
    void task.catch(() => undefined);
    return task;
  }

  function resource({ value, presence }: { value: string, presence: 'allowed' | 'forbidden' }): { url: string, path: string, aliased: boolean } {
    const url = new URL(value);
    const prefix = `/${modelId}/resolve/`;
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.port || url.username || url.password || !url.pathname.startsWith(prefix)) {
      throw new Error('Unexpected metadata resource identity');
    }
    const [requestedRevision, ...parts] = url.pathname.slice(prefix.length).split('/');
    const path = parts.map(decodeURIComponent).join('/');
    if (!path || parts.some(part => !part || decodeURIComponent(part) === '.' || decodeURIComponent(part) === '..' || /[\\/?#]/u.test(decodeURIComponent(part)))) {
      throw new Error('Noncanonical metadata resource identity');
    }
    if (path.startsWith('onnx/') || isModelWeightFileName({ fileName: path.split('/').at(-1)! })) {
      url.search = ''; url.hash = '';
      throw new Error(`Runtime artifact preparation MUST NOT fetch model artifacts: ${url.href}`);
    }
    const allowPresence = (() => {
      switch (presence) {
      case 'allowed': return true;
      case 'forbidden': return false;
      default: { const exhaustive: never = presence; throw new Error(`Unknown presence policy: ${exhaustive}`); }
      }
    })();
    const aliased = requestedRevision === 'main' && allowPresence && presencePaths.has(path);
    if (requestedRevision !== revision && !aliased) throw new Error('Unexpected metadata revision identity');
    url.pathname = `${prefix}${revision}/${parts.join('/')}`;
    // Query strings do not create a separate cache identity. Transport keeps
    // its original query; signed/redirect credentials are never persisted.
    url.search = ''; url.hash = '';
    return { url: url.href, path, aliased };
  }

  function ownResponse({ response, url, obligation }: { response: Response, url: string, obligation: 'save' | 'cached' | 'probe' | 'none' }): Response {
    function recordSize({ size }: { size: number | undefined }) {
      switch (obligation) {
      case 'save': required.set(url, size); return;
      case 'cached':
      case 'probe':
      case 'none': return;
      default: { const exhaustive: never = obligation; throw new Error(`Unknown response obligation: ${exhaustive}`); }
      }
    }
    const expected = expectedDecodedResponseByteLength({ response });
    if (expected !== undefined && expected > maximumByteLength) {
      // Retain the reader before throwing so cleanup owns unread responses too.
      if (response.body !== null) {
        const reader = response.body.getReader();
        ownLease({ lease: { cancel: () => reader.cancel() } });
      }
      throw new Error(`Runtime artifact preparation refused an unexpectedly large non-model artifact (${expected} bytes)`);
    }
    recordSize({ size: expected });
    if (response.body === null) return response;
    const reader = response.body.getReader();
    let ended = false;
    let received = 0;
    const lease = { async cancel() {
      if (ended) return;
      ended = true;
      await reader.cancel();
    } };
    ownLease({ lease });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          check();
          const item = await reader.read();
          check();
          if (item.done) {
            ended = true; leases.delete(lease);
            if (expected !== undefined && received !== expected) throw new Error('Metadata response byte length mismatch');
            recordSize({ size: received });
            controller.close(); return;
          }
          received += item.value.byteLength;
          if (received > maximumByteLength) throw new Error(`Runtime artifact preparation exceeded the non-model artifact byte limit (${maximumByteLength} bytes)`);
          controller.enqueue(item.value);
        } catch (error) {
          controller.error(fail({ error }));
        }
      },
      // Do not await cancellation of a tee branch. We own the original reader,
      // which can be stopped even while another response clone remains unread.
      async cancel() {
        await cancelLease({ lease });
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  const fetchMetadata: typeof fetch = (input, init) => tracked({ run: async () => {
    // Request merges method/headers/signal with the platform's own precedence.
    // Relative remote requests are not valid for this exact HF-only operation.
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const probe = request.method === 'GET' && request.headers.get('Range') === 'bytes=0-0';
    if (request.method !== 'GET') throw new Error('Unexpected metadata request method');
    const id = resource({ value: request.url, presence: probe ? 'allowed' : 'forbidden' });
    // TJS also probes the size of any exact-revision metadata resource when
    // its full GET omits Content-Length. This is independent of the two known
    // revisionless presence probes: resource() alone owns that alias policy.
    // Neither kind of probe may acquire a full-resource save obligation.
    if (request.headers.has('Range') && !probe) {
      throw new Error('Unexpected metadata Range request');
    }
    const target = new URL(request.url);
    target.pathname = new URL(id.url).pathname;
    const canonical = new Request(target, request);
    const response = await downloadFetch(canonical, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    // Optional 404 and probes are never promoted to required saved metadata.
    const obligation = probe ? 'probe' : response.status === 200 ? 'save' : 'none';
    const owned = ownResponse({ response, url: id.url, obligation });
    if (probe && (response.status === 200 || response.status === 206)) {
      // TJS may allocate its full-file read buffer from the probe's advertised
      // total before consuming the actual full response. Bounding only the
      // one-byte probe body does not bound that allocation. Match the pinned
      // runtime's header interpretation; absent/unparseable sizes remain unknown.
      const rangeSize = response.status === 206
        ? response.headers.get('Content-Range')?.match(/bytes \d+-\d+\/(\d+)/u)?.[1]
        : undefined;
      const advertisedSize = Number.parseInt(rangeSize ?? response.headers.get('Content-Length') ?? '', 10);
      if (!Number.isNaN(advertisedSize) && (!Number.isSafeInteger(advertisedSize) || advertisedSize < 0 || advertisedSize > maximumByteLength)) {
        throw new Error('Metadata probe advertised an invalid or oversized resource size');
      }
    }
    if (!probe && response.status !== 404) {
      const error = fullResourceResponseError({ response });
      if (error !== undefined) throw error;
    }
    if (response.status !== 200 && response.status !== 404 && !(probe && response.status === 206)) {
      throw new Error(`Metadata HTTP status ${response.status} is not an optional absence or complete response`);
    }
    if (response.status === 200 && response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) {
      throw new Error('HTML response is not runtime metadata');
    }
    request.signal.throwIfAborted();
    check();
    return owned;
  } });

  const cache = {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- TJS Cache-compatible boundary.
    match(input: string | Request): Promise<Response | undefined> {
      return tracked({ run: async () => {
        const value = typeof input === 'string' ? input : input.url;
        // Ignore only the known same-model local lookup made before the HF key.
        // Do not read user uploads or mutable local-path cache aliases.
        if (value.startsWith(`/models/${modelId}/`)) return undefined;
        const id = resource({ value, presence: 'allowed' });
        if (id.aliased) {
          const size = await storage.stat({ url: id.url });
          check();
          if (size === undefined) return undefined;
          if (size > maximumByteLength) throw new Error('Cached metadata exceeds byte limit');
          return new Response(null, { headers: { 'Content-Length': String(size) } });
        }
        // Stat first prevents an oversized cached resource from opening a body.
        const size = await storage.stat({ url: id.url });
        check();
        if (size === undefined) return undefined;
        if (size > maximumByteLength) throw new Error('Cached metadata exceeds byte limit');
        const stored = await storage.read({ url: id.url });
        const owned = stored === undefined ? undefined : ownResponse({ response: stored.response, url: id.url, obligation: 'cached' });
        check();
        if (stored === undefined || stored.byteLength !== size) throw new Error('Metadata changed after cache stat');
        required.set(id.url, size);
        return owned;
      } });
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- TJS Cache-compatible boundary.
    put(input: string | Request, response: Response): Promise<void> {
      return tracked({ run: async () => {
        const id = resource({ value: typeof input === 'string' ? input : input.url, presence: 'forbidden' });
        if (response.status !== 200) {
          ownResponse({ response, url: id.url, obligation: 'none' });
          if (response.status !== 404) {
            const error = fullResourceResponseError({ response });
            if (error !== undefined) throw error;
          }
          return;
        }
        const previous = writes.get(id.url);
        const task = (async () => {
          await previous;
          check();
          const guarded = ownResponse({ response, url: id.url, obligation: 'save' });
          const error = fullResourceResponseError({ response });
          if (error !== undefined) throw error;
          if (response.headers.get('Content-Type')?.toLowerCase().includes('text/html')) throw new Error('HTML response is not runtime metadata');
          await storage.write({ url: id.url, response: guarded });
          check();
          const size = await storage.stat({ url: id.url });
          check();
          if (size === undefined || size !== required.get(id.url)) throw new Error('Metadata is not durably complete after write');
        })();
        writes.set(id.url, task);
        try {
          await task;
        } finally {
          if (writes.get(id.url) === task) writes.delete(id.url);
        }
      } });
    },
  };

  async function cleanup() {
    draining = true;
    // Keep draining newly registered leases. A pending fetch/read may return a
    // response after cleanup starts; ownLease also handles post-timeout arrivals.
    const drained = (async () => {
      while (pending.size > 0 || leases.size > 0 || cancellations.size > 0) {
        for (const lease of leases) void cancelLease({ lease }).catch(() => undefined);
        const results = await Promise.allSettled([...pending, ...cancellations]);
        for (const result of results) {
          switch (result.status) {
          case 'rejected': fail({ error: result.reason }); break;
          case 'fulfilled': break;
          default: {
            const unexpected: never = result;
            throw new Error(`Unexpected metadata cleanup result: ${String(unexpected)}`);
          }
          }
        }
      }
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Metadata cleanup deadline exceeded; retire this Worker')), RUNTIME_METADATA_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      fail({ error });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      state = 'closed'; required.clear(); writes.clear();
    }
  }

  return {
    cache,
    fetch: fetchMetadata,
    async finish() {
      assertActive();
      state = 'finishing';
      try {
        // Includes puts the upstream caller started but did not await.
        check();
        while (pending.size > 0) {
          await Promise.race([
            Promise.allSettled([...pending]),
            failed.promise.then(() => {
              throw failure!.error;
            }),
          ]);
          check();
        }
        check();
        for (const [url, expected] of required) {
          const size = await storage.stat({ url });
          check();
          if (expected === undefined || size !== expected || size === 0) throw new Error('Metadata preparation lacks a complete saved resource');
        }
      } catch (error) {
        fail({ error });
      }
      await cleanup();
      if (failure !== undefined) throw failure.error;
    },
    async abort({ error }: { error: unknown }) {
      switch (state) {
      case 'closed': throw fail({ error });
      case 'active':
      case 'finishing': break;
      default: { const exhaustive: never = state; throw new Error(`Unknown operation state: ${exhaustive}`); }
      }
      fail({ error }); state = 'finishing';
      await cleanup();
      throw failure!.error;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
