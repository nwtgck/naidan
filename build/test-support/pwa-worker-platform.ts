// Node execution harness for the REAL generated service worker. This implements
// only browser APIs; it does not replace application modules or the Workbox code.
import vm from 'node:vm';

function cacheKey(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

class MemoryCache {
  readonly entries = new Map<string, Response>();
  async match(input: RequestInfo | URL, options?: CacheQueryOptions): Promise<Response | undefined> {
    const key = cacheKey(input);
    if (!options?.ignoreSearch) return this.entries.get(key)?.clone();
    const path = new URL(key); path.search = '';
    for (const [candidate, response] of this.entries) {
      const url = new URL(candidate); url.search = '';
      if (url.href === path.href) return response.clone();
    }
    return undefined;
  }
  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(cacheKey(input), response.clone());
  }
  async delete(input: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(cacheKey(input));
  }
  async keys(): Promise<Request[]> {
    return Array.from(this.entries.keys(), url => new Request(url));
  }
}

export class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();
  async open(name: string): Promise<Cache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache(); this.stores.set(name, cache);
    }
    return cache as unknown as Cache;
  }
  async keys(): Promise<string[]> {
    return Array.from(this.stores.keys());
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
  async match(input: RequestInfo | URL, options?: MultiCacheQueryOptions): Promise<Response | undefined> {
    for (const [name, cache] of this.stores) {
      if (options?.cacheName && name !== options.cacheName) continue;
      const hit = await cache.match(input, options);
      if (hit) return hit;
    }
    return undefined;
  }
  native(): CacheStorage {
    return this as unknown as CacheStorage;
  }
}

export type TestClient = { id: string; type: 'window' | 'worker' | 'sharedworker'; url: string; postMessage?: (message: unknown) => void };
export class TestClients {
  readonly clients = new Map<string, TestClient>();
  async get(id: string): Promise<TestClient | undefined> {
    return this.clients.get(id);
  }
  async matchAll(options?: { type?: string }): Promise<TestClient[]> {
    return Array.from(this.clients.values()).filter(client => !options?.type || options.type === 'all' || client.type === options.type);
  }
}

class LifetimeEvent extends Event {
  readonly tasks: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.tasks.push(promise);
    // Native waitUntil observes rejections immediately, including tasks added
    // while an earlier lifetime promise is pending.
    void promise.catch(() => {});
  }
  async finished(): Promise<void> {
    let count = -1;
    let failure: PromiseRejectedResult | undefined;
    while (count !== this.tasks.length) {
      count = this.tasks.length;
      const results = await Promise.allSettled(this.tasks);
      failure ??= results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    }
    // An install fails after its lifetime tasks settle, not before diagnostics
    // registered during the failure have had their delivery opportunity.
    if (failure) throw failure.reason;
  }
}

class RequestEvent extends LifetimeEvent {
  response: Promise<Response> | undefined;
  clientId = '';
  resultingClientId = '';
  readonly request: Request;
  constructor(request: Request) {
    super('fetch'); this.request = request;
  }
  respondWith(response: Promise<Response> | Response): void {
    if (this.response) throw new Error('respondWith called twice');
    this.response = Promise.resolve(response);
  }
}

export function createWorkerHarness({ script, scope, cacheStorage, clients, fetch }: {
  script: string;
  scope: string;
  cacheStorage: MemoryCacheStorage;
  clients: TestClients;
  fetch: typeof globalThis.fetch;
}) {
  const target = new EventTarget();
  const location = new URL('sw.js', scope);
  const listeners = new Map<EventListenerOrEventListenerObject, EventListener>();
  const global = {
    location, registration: { scope }, caches: cacheStorage.native(), clients,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      let wrapper = listeners.get(listener);
      if (!wrapper) {
        // Browsers ignore a listener's return value; Node's EventTarget instead
        // turns a returned rejected Promise into an uncaught exception. Workbox
        // registers that SAME promise via waitUntil, which we observe above.
        wrapper = event => {
          if (typeof listener === 'function') listener.call(global, event);
          else listener.handleEvent(event);
        };
        listeners.set(listener, wrapper);
      }
      target.addEventListener(type, wrapper);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const wrapper = listeners.get(listener);
      if (wrapper) target.removeEventListener(type, wrapper);
    },
    skipWaiting: async () => {},
  };
  vm.runInNewContext(script, {
    self: global, location, registration: global.registration,
    navigator: { userAgent: 'Naidan worker test' }, caches: cacheStorage.native(), fetch,
    // Errors from the host-backed fetch/cache APIs belong to the worker realm
    // in browsers. Share their constructors so Workbox's instanceof checks match.
    Error, TypeError, DOMException,
    Request, Response, Headers, URL, URLSearchParams, console,
    ExtendableEvent: LifetimeEvent, FetchEvent: RequestEvent,
    setTimeout, clearTimeout, performance, Promise,
  }, { filename: 'generated-sw.js' });

  function lifecycle(type: 'install' | 'activate'): Promise<void> {
    const event = new LifetimeEvent(type);
    target.dispatchEvent(event);
    return event.finished();
  }

  async function request({ url, clientId = '', resultingClientId = '', navigation = false, destination = '', referrer = '' }: {
    url: string;
    clientId?: string;
    resultingClientId?: string;
    navigation?: boolean;
    destination?: string;
    referrer?: string;
  }): Promise<Response> {
    // Node's Request constructor cannot create browser-generated navigate
    // requests, so supply their read-only event metadata explicitly.
    const request = new Request(url, referrer ? { referrer } : undefined);
    Object.defineProperty(request, 'destination', { value: destination });
    if (navigation) Object.defineProperty(request, 'mode', { value: 'navigate' });
    const event = new RequestEvent(request);
    event.clientId = clientId; event.resultingClientId = resultingClientId;
    target.dispatchEvent(event);
    if (!event.response) throw new Error('No service-worker response');
    const response = await event.response;
    await event.finished();
    return response;
  }

  async function message({ data, clientId }: { data: unknown; clientId: string }): Promise<unknown> {
    let reply: unknown;
    const event = Object.assign(new LifetimeEvent('message'), {
      data, source: clients.clients.get(clientId),
      ports: [{ postMessage(value: unknown) {
        reply = value;
      } }],
    });
    target.dispatchEvent(event); await event.finished();
    return reply;
  }
  return { lifecycle, request, message };
}

export const TEST_ONLY = {};
