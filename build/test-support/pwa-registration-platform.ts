// A small lifecycle model: only native slots, event ordering, message sources and
// routing live here. Build identities and update decisions stay in production code.
import { createWorkerHarness, MemoryCacheStorage, TestClients } from './pwa-worker-platform';

type Worker = {
  key: string;
  state: ServiceWorkerState;
  handles: Map<string, ServiceWorker>;
  runtime: ReturnType<typeof createWorkerHarness>;
  skipped: boolean;
};

function assertRunning({ worker }: { worker: Worker }): void {
  switch (worker.state) {
  case 'redundant': throw new Error('Worker terminated');
  case 'parsed':
  case 'installing':
  case 'installed':
  case 'activating':
  case 'activated': return;
  default: { const exhaustive: never = worker.state; throw new Error(`Unexpected worker state: ${exhaustive}`); }
  }
}

export function createRegistrationPlatform({ scope, fetch }: { scope: string; fetch: typeof globalThis.fetch }) {
  const storage = new MemoryCacheStorage();
  const clients = new TestClients();
  const workers = new Map<string, Worker>();
  const registrations = new Map<string, ServiceWorkerRegistration>();
  const pages = new Map<string, { container: ServiceWorkerContainer; controlled: Worker | undefined }>();
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  let active: Worker | undefined;
  let installing: Worker | undefined;
  let waiting: Worker | undefined;

  function track({ task }: { task: Promise<unknown> }): void {
    pending.add(task);
    void task.catch(error => failures.push(error)).finally(() => pending.delete(task));
  }

  function handle({ worker, viewer }: { worker: Worker | undefined; viewer: string }): ServiceWorker | null {
    if (!worker) return null;
    let value = worker.handles.get(viewer);
    if (!value) {
      value = Object.assign(new EventTarget(), {
        get state() {
          return worker.state;
        },
        scriptURL: new URL('sw.js', scope).href,
        postMessage(data: unknown, ports: MessagePort[] = []) {
          assertRunning({ worker });
          const sender = workers.get(viewer);
          track({ task: worker.runtime.messageWithPorts({ data, clientId: viewer, ports, source: sender ? handle({ worker: sender, viewer: worker.key }) : clients.clients.get(viewer) }) });
        },
      }) as unknown as ServiceWorker;
      // Object.assign evaluates getters: preserve native-style live properties.
      Object.defineProperty(value, 'state', { get: () => worker.state });
      worker.handles.set(viewer, value);
    }
    return value;
  }

  function registration({ viewer }: { viewer: string }): ServiceWorkerRegistration {
    let value = registrations.get(viewer);
    if (!value) {
      value = Object.assign(new EventTarget(), { scope, update: async () => value }) as unknown as ServiceWorkerRegistration;
      for (const [name, read] of [['active', () => active], ['installing', () => installing], ['waiting', () => waiting]] as const) {
        Object.defineProperty(value, name, { get: () => handle({ worker: read(), viewer }) });
      }
      registrations.set(viewer, value);
    }
    return value;
  }

  function transition({ worker, state }: { worker: Worker; state: ServiceWorkerState }): void {
    worker.state = state;
    for (const view of worker.handles.values()) view.dispatchEvent(new Event('statechange'));
  }

  async function tryActivate(): Promise<void> {
    if (!waiting || installing === waiting || active?.state === 'activating') return;
    if (active && !waiting.skipped && [...pages.values()].some(page => page.controlled)) return;
    const next = waiting;
    const previous = active;
    waiting = undefined;
    active = next;
    transition({ worker: next, state: 'activating' });
    if (previous) transition({ worker: previous, state: 'redundant' });
    for (const page of pages.values()) {
      // No implicit clients.claim(): initially uncontrolled documents stay so.
      if (!page.controlled) continue;
      page.controlled = next;
      page.container.dispatchEvent(new Event('controllerchange'));
    }
    await next.runtime.lifecycle('activate');
    transition({ worker: next, state: 'activated' });
  }

  function addWorker({ key, script }: { key: string; script: string }): void {
    const worker = { key, state: 'parsed', handles: new Map(), skipped: false } as Worker;
    workers.set(key, worker);
    worker.runtime = createWorkerHarness({
      script,
      scope,
      cacheStorage: storage,
      fetch,
      clients: {
        clients: clients.clients,
        get: clients.get.bind(clients),
        matchAll: async () => [...clients.clients.values()].filter(client => pages.get(client.id)?.controlled === worker),
      },
      registration: registration({ viewer: key }),
      skipWaiting: async () => {
        worker.skipped = true;
        // skipWaiting resolves the request, not activation. Queue the lifecycle.
        track({ task: Promise.resolve().then(tryActivate) });
      },
    });
  }

  async function install({ key }: { key: string }): Promise<void> {
    const worker = workers.get(key)!;
    installing = worker;
    transition({ worker, state: 'installing' });
    for (const view of registrations.values()) view.dispatchEvent(new Event('updatefound'));
    try {
      await worker.runtime.lifecycle('install');
      if (waiting) transition({ worker: waiting, state: 'redundant' });
      waiting = worker;
      installing = undefined;
      transition({ worker, state: 'installed' });
      await tryActivate();
    } catch (error) {
      installing = undefined;
      transition({ worker, state: 'redundant' });
      throw error;
    }
  }

  function page({ key }: { key: string }): ServiceWorkerContainer {
    clients.clients.set(key, { id: key, type: 'window', url: scope });
    const view = registration({ viewer: key });
    const container = Object.assign(new EventTarget(), {
      getRegistration: async () => view,
      register: async () => view,
    }) as unknown as ServiceWorkerContainer;
    const record = { container, controlled: active };
    pages.set(key, record);
    Object.defineProperty(container, 'controller', { get: () => handle({ worker: record.controlled, viewer: key }) });
    return container;
  }

  async function request({ pageKey, path = '', navigation = false }: { pageKey: string; path?: string; navigation?: boolean }): Promise<Response> {
    const controller = pages.get(pageKey)?.controlled;
    const url = new URL(path, scope).href;
    if (!controller) return fetch(new Request(url));
    assertRunning({ worker: controller });
    return controller.runtime.request({ url, clientId: pageKey, navigation });
  }

  return { storage, clients, workers, pages, pending, failures, addWorker, install, page, request, registration };
}

export const TEST_ONLY = {
};
