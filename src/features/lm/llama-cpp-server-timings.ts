import { z } from 'zod';
import type { LlamaCppServerTimingsMode } from '@/01-models/types';
import type { LmFetch } from './fetch';

const WAIT_MS = 300;
const PROBE_MS = 1500;
const SUPPORTED_TTL_MS = 5 * 60 * 1000;
const UNKNOWN_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 32;
const MAX_PROPS_BYTES = 1024 * 1024;
const propsSchema = z.object({
  default_generation_settings: z.object({
    params: z.object({ timings_per_token: z.boolean() }),
  }),
});

type Entry =
  | { kind: 'pending', promise: Promise<boolean>, controller: AbortController }
  | { kind: 'complete', supported: boolean, expiresAt: number };

function derivePropsUrl({ endpoint }: { endpoint: string }): string | undefined {
  try {
    const url = new URL(endpoint);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
      return undefined;
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.endsWith('/v1')) {
      return undefined;
    }
    url.pathname = `${path.slice(0, -3)}/props`;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Detection is optional: neither credentials nor remote response bodies enter error logs. */
async function probe({ url, headers, fetcher, signal }: { url: string, headers: [string, string][] | undefined, fetcher: LmFetch, signal: AbortSignal }): Promise<boolean> {
  const response = await fetcher(url, { method: 'GET', headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  // A custom fetch may ignore abort and resolve after the deadline.
  if (signal.aborted || !response.ok || response.redirected) {
    void response.body?.cancel().catch(() => {});
    return false;
  }
  if (!response.body) {
    return false;
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    const decoder = new TextDecoder();
    let nBytes = 0;
    let text = '';
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        if (signal.aborted) {
          return false;
        }
        text += decoder.decode();
        const value: unknown = JSON.parse(text);
        return propsSchema.safeParse(value).success;
      }
      nBytes += result.value.byteLength;
      if (nBytes > MAX_PROPS_BYTES) {
        return false;
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return false;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) {
      cancel();
    }
    reader.releaseLock();
  }
}

/** A generation owns its wait, never another generation's shared probe. */
function waitForProbe({ promise, signal }: { promise: Promise<boolean>, signal: AbortSignal }): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = ({ supported }: { supported: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(supported);
    };
    const onAbort = () => finish({ supported: false });
    const timer = setTimeout(onAbort, WAIT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(supported => finish({ supported }), () => finish({ supported: false }));
  });
}

function createDetector({ fetcher, now = () => performance.now() }: { fetcher: LmFetch, now?: () => number }) {
  const entries = new Map<string, Entry>();

  function startProbe({ key, url, headers }: { key: string, url: string, headers: [string, string][] | undefined }): Entry & { kind: 'pending' } {
    const controller = new AbortController();
    const deferred = Promise.withResolvers<boolean>();
    const entry: Entry & { kind: 'pending' } = { kind: 'pending', promise: deferred.promise, controller };
    entries.set(key, entry);
    let settled = false;
    const finish = ({ supported }: { supported: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (entries.get(key) === entry) {
        entries.set(key, { kind: 'complete', supported, expiresAt: now() + (supported ? SUPPORTED_TTL_MS : UNKNOWN_TTL_MS) });
      }
      deferred.resolve(supported);
    };
    const onAbort = () => finish({ supported: false });
    const timer = setTimeout(() => controller.abort(), PROBE_MS);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    // Rejections are contained even if a fetch implementation ignores cancellation.
    void probe({ url, headers, fetcher, signal: controller.signal }).then(
      supported => finish({ supported }),
      () => finish({ supported: false }),
    );
    return entry;
  }

  async function resolve({ endpoint, headers, signal }: { endpoint: string, headers: [string, string][] | undefined, signal: AbortSignal }): Promise<boolean> {
    const url = derivePropsUrl({ endpoint });
    if (url === undefined || signal.aborted) {
      return false;
    }
    for (const [key, entry] of entries) {
      if (entry.kind === 'complete' && entry.expiresAt <= now()) {
        entries.delete(key);
      }
    }
    const requestHeaders = headers?.map(([name, value]): [string, string] => [name, value]);
    // Exact headers isolate authentication contexts. Keys stay in this bounded memory cache.
    const key = JSON.stringify([url, requestHeaders ?? []]);
    const cached = entries.get(key);
    if (cached === undefined) {
      while (entries.size >= MAX_ENTRIES) {
        const oldest = entries.entries().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest[0]);
        const evicted = oldest[1];
        switch (evicted.kind) {
        case 'pending': evicted.controller.abort();
          break;
        case 'complete': break;
        default: {
          const exhaustive: never = evicted;
          throw new Error(String(exhaustive));
        }
        }
      }
    }
    const entry = cached ?? startProbe({ key, url, headers: requestHeaders });
    switch (entry.kind) {
    case 'complete': return entry.supported;
    case 'pending': return await waitForProbe({ promise: entry.promise, signal });
    default: {
      const exhaustive: never = entry;
      throw new Error(String(exhaustive));
    }
    }
  }

  return { resolve };
}

// Different fetch transports (including fake endpoints) must not share evidence.
const detectors = new WeakMap<LmFetch, ReturnType<typeof createDetector>>();

export async function resolveLlamaCppServerTimings({ mode, endpoint, headers, fetcher, signal }: {
  mode: LlamaCppServerTimingsMode,
  endpoint: string,
  headers: [string, string][] | undefined,
  fetcher: LmFetch,
  signal: AbortSignal,
}): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  switch (mode) {
  case 'disabled': return false;
  case 'enabled': return true;
  case 'auto': {
    let detector = detectors.get(fetcher);
    if (detector === undefined) {
      detector = createDetector({ fetcher });
      detectors.set(fetcher, detector);
    }
    return await detector.resolve({ endpoint, headers, signal });
  }
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
  derivePropsUrl,
  createDetector,
  WAIT_MS,
  PROBE_MS,
  SUPPORTED_TTL_MS,
  UNKNOWN_TTL_MS,
  MAX_ENTRIES,
  MAX_PROPS_BYTES,
};
