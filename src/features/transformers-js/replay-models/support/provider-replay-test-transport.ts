import { MessageChannel, MessagePort } from 'node:worker_threads';
import { z } from 'zod';
// eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- The platform adapter describes a real Comlink MessagePort endpoint; no custom RPC protocol.
import type { Endpoint } from 'comlink';
import type { ProductionRuntimeModuleEndpoint } from '@/features/transformers-js/worker/production-worker-startup';

const workerOptionsSchema = z.object({ type: z.literal('module') }).strict();

function readListenerCapture({ options }: { options: boolean | EventListenerOptions | undefined }): boolean {
  return Boolean(typeof options === 'boolean' ? options : options?.capture);
}

function readListenerOptions({ options }: { options: boolean | AddEventListenerOptions | undefined }): AddEventListenerOptions & { capture: boolean } {
  // Read standard fields once, including inherited/accessor properties. Node's
  // removeEventListener boolean overload differs from browser capture matching.
  const capture = readListenerCapture({ options });
  return typeof options === 'boolean' || options === undefined
    ? { capture }
    : { capture, once: options.once, passive: options.passive, signal: options.signal };
}

export type ProviderReplayTestWorkerConstructor = new (url: string | URL, options: WorkerOptions | undefined) => ProviderReplayTestWorker;

/** One literal Production bootstrap, not a dispatcher that repairs unknown entries. */
export function createProviderReplayTestWorkerConstructor({ scriptUrl, start, onConstructed }: {
  scriptUrl: URL,
  start: ({ worker }: { worker: ProviderReplayTestWorker }) => Promise<void>,
  onConstructed: ({ worker }: { worker: ProviderReplayTestWorker }) => void,
}): ProviderReplayTestWorkerConstructor {
  // A retained endpoint must not retain the harness through its constructor.
  // The one permitted instance consumes these delegates after super succeeds.
  let pending: { start: typeof start, onConstructed: typeof onConstructed } | undefined = { start, onConstructed };
  return class extends ProviderReplayTestWorker {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the browser Worker constructor without changing its arguments.
    constructor(url: string | URL, options: WorkerOptions | undefined) {
      if (String(url) !== scriptUrl.href) throw new Error(`Unexpected replay Worker script: ${String(url)}`);
      workerOptionsSchema.parse(options);
      if (!pending) throw new Error('Replay supports one Production Realm per fixture; unexpected restart or Download');
      const callbacks = pending;
      // Validate before super creates native channels or schedules startup.
      super({ start: callbacks.start });
      pending = undefined;
      callbacks.onConstructed({ worker: this });
    }
  };
}

/** Native MessagePorts, including Comlink's transferred callback ports. No fake RPC or ready. */
export class ProviderReplayTestWorker extends EventTarget {
  readonly channel = new MessageChannel();
  private readonly endpointListeners: Array<{
    type: Parameters<Endpoint['addEventListener']>[0],
    listener: Parameters<Endpoint['addEventListener']>[1],
    capture: boolean,
  }> = [];
  readonly hostMessages: unknown[] = [];
  readonly workerMessages: unknown[] = [];
  readonly endpoint: Endpoint = {
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport, local-rules-named-args/require-named-args -- Native Comlink Endpoint forwarding preserves positional messages and transferred callback ports.
    postMessage: (message, transfer) => this.channel.port2.postMessage(message, transfer as Parameters<MessagePort['postMessage']>[1]),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the external Comlink Endpoint event-listener signature.
    addEventListener: (...args: Parameters<Endpoint['addEventListener']>) => {
      if (this.terminated) return;
      const [type, listener, options] = args;
      const normalized = readListenerOptions({ options });
      // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Audited Node platform endpoint installs Comlink's actual listener before observational bookkeeping starts the port.
      this.channel.port2.addEventListener(type, listener, normalized);
      const { capture } = normalized;
      if (!this.endpointListeners.some(item => item.type === type && item.listener === listener && item.capture === capture)) {
        this.endpointListeners.push({ type, listener, capture });
      }
      this.observeWorkerTransfers();
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the external Comlink Endpoint event-listener signature.
    removeEventListener: (...args: Parameters<Endpoint['removeEventListener']>) => {
      const [type, listener, options] = args;
      const capture = readListenerCapture({ options });
      this.channel.port2.removeEventListener(type, listener, { capture });
      for (let index = this.endpointListeners.length - 1; index >= 0; index--) {
        const item = this.endpointListeners[index]!;
        if (item.type === type && item.listener === listener && item.capture === capture) this.endpointListeners.splice(index, 1);
      }
    },
    start: () => this.channel.port2.start(),
  };
  readonly startupEndpoint = this.endpoint as unknown as ProductionRuntimeModuleEndpoint;
  private readonly transferredPorts = new Set<MessagePort>();
  private observingWorkerTransfers = false;
  terminated = false;

  constructor({ start }: { start: ({ worker }: { worker: ProviderReplayTestWorker }) => Promise<void> }) {
    super();
    this.observeHostMessages();
    // A browser Worker queues host messages until its script installs a consumer.
    // An eager Node observer would start this port and discard queued RPC while
    // dynamic entry import is still pending. Observe only after the real consumer.
    // The host constructs its actual session before startup can send anything.
    // This is a task ownership boundary, not a readiness delay or callback drain.
    void Promise.resolve().then(() => start({ worker: this })).catch(error => {
      this.dispatchEvent(new MessageEvent('error', { data: error }));
    });
  }

  private observeHostMessages() {
    // Do not share the listener's lexical context with the startup delegate.
    this.channel.port1.on('message', data => {
      this.ownTransferredPorts({ value: data });
      this.workerMessages.push(data);
      this.dispatchEvent(new MessageEvent('message', { data }));
    });
  }

  private observeWorkerTransfers() {
    if (this.observingWorkerTransfers) return;
    this.observingWorkerTransfers = true;
    this.channel.port2.on('message', data => this.ownTransferredPorts({ value: data }));
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Browser Worker positional transport boundary; only Node MessagePorts are transferred here.
  postMessage(message: unknown, transfer: Parameters<MessagePort['postMessage']>[1]) {
    // Closed native ports still validate structured cloning, then discard the
    // send. In particular, Comlink's GC release is not a new live host request.
    if (!this.terminated) this.hostMessages.push(message);
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Audited native Worker platform adapter forwards unchanged structured-clone messages and transferred callback ports.
    this.channel.port1.postMessage(message, transfer);
  }

  sendFromWorker({ message }: { message: unknown }) {
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- The actual startup helper supplies the versioned validated message; no synthetic readiness.
    this.channel.port2.postMessage(message);
  }

  private ownTransferredPorts({ value }: { value: unknown }) {
    const visited = new Set<object>();
    const visit = ({ item }: { item: unknown }): void => {
      if (item === null || typeof item !== 'object' || visited.has(item)) return;
      visited.add(item);
      if (item instanceof MessagePort) {
        this.transferredPorts.add(item);
        return;
      }
      // This observes native clone payloads without changing their shape or
      // delivery. Worker disposal must also close Comlink's callback channels.
      for (const child of Object.values(item)) visit({ item: child });
    };
    visit({ item: value });
  }

  terminate() {
    this.terminated = true;
    // A real Worker destroys its Realm. Node close() alone retains listeners
    // and hence exposed APIs, including a same-Realm path back to host proxies.
    for (const { type, listener, capture } of this.endpointListeners.splice(0)) {
      this.channel.port2.removeEventListener(type, listener, { capture });
    }
    this.channel.port1.close();
    this.channel.port2.close();
    for (const port of this.transferredPorts) port.close();
    this.transferredPorts.clear();
  }
}

export const TEST_ONLY = {
};
