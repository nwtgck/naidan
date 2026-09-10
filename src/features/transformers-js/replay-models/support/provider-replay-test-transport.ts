import { MessageChannel, MessagePort } from 'node:worker_threads';
import { z } from 'zod';
// eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- The platform adapter describes a real Comlink MessagePort endpoint; no custom RPC protocol.
import type { Endpoint } from 'comlink';
import type { ProductionRuntimeModuleEndpoint } from '@/features/transformers-js/worker/production-worker-startup';

const workerOptionsSchema = z.object({ type: z.literal('module') }).strict();

export type ProviderReplayTestWorkerConstructor = new (url: string | URL, options: WorkerOptions | undefined) => ProviderReplayTestWorker;

/** One literal Production bootstrap, not a dispatcher that repairs unknown entries. */
export function createProviderReplayTestWorkerConstructor({ scriptUrl, start, onConstructed }: {
  scriptUrl: URL,
  start: ({ worker }: { worker: ProviderReplayTestWorker }) => Promise<void>,
  onConstructed: ({ worker }: { worker: ProviderReplayTestWorker }) => void,
}): ProviderReplayTestWorkerConstructor {
  let constructed = false;
  return class extends ProviderReplayTestWorker {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the browser Worker constructor without changing its arguments.
    constructor(url: string | URL, options: WorkerOptions | undefined) {
      if (String(url) !== scriptUrl.href) throw new Error(`Unexpected replay Worker script: ${String(url)}`);
      workerOptionsSchema.parse(options);
      if (constructed) throw new Error('Replay supports one Production Realm per fixture; unexpected restart or Download');
      // Validate before super creates native channels or schedules startup.
      super({ start });
      constructed = true;
      onConstructed({ worker: this });
    }
  };
}

/** Native MessagePorts, including Comlink's transferred callback ports. No fake RPC or ready. */
export class ProviderReplayTestWorker extends EventTarget {
  readonly channel = new MessageChannel();
  readonly hostMessages: unknown[] = [];
  readonly workerMessages: unknown[] = [];
  readonly endpoint: Endpoint = {
    // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport, local-rules-named-args/require-named-args -- Native Comlink Endpoint forwarding preserves positional messages and transferred callback ports.
    postMessage: (message, transfer) => this.channel.port2.postMessage(message, transfer as Parameters<MessagePort['postMessage']>[1]),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the external Comlink Endpoint event-listener signature.
    addEventListener: (...args: Parameters<Endpoint['addEventListener']>) => {
      // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Audited Node platform endpoint installs Comlink's actual listener before observational bookkeeping starts the port.
      this.channel.port2.addEventListener(...args);
      this.observeWorkerTransfers();
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the external Comlink Endpoint event-listener signature.
    removeEventListener: (...args: Parameters<Endpoint['removeEventListener']>) => this.channel.port2.removeEventListener(...args),
    start: () => this.channel.port2.start(),
  };
  readonly startupEndpoint = this.endpoint as unknown as ProductionRuntimeModuleEndpoint;
  private readonly transferredPorts = new Set<MessagePort>();
  private observingWorkerTransfers = false;
  terminated = false;

  constructor({ start }: { start: ({ worker }: { worker: ProviderReplayTestWorker }) => Promise<void> }) {
    super();
    this.channel.port1.on('message', data => {
      this.ownTransferredPorts({ value: data });
      this.workerMessages.push(data);
      this.dispatchEvent(new MessageEvent('message', { data }));
    });
    // A browser Worker queues host messages until its script installs a consumer.
    // An eager Node observer would start this port and discard queued RPC while
    // dynamic entry import is still pending. Observe only after the real consumer.
    // The host constructs its actual session before startup can send anything.
    // This is a task ownership boundary, not a readiness delay or callback drain.
    void Promise.resolve().then(() => start({ worker: this })).catch(error => {
      this.dispatchEvent(new MessageEvent('error', { data: error }));
    });
  }

  private observeWorkerTransfers() {
    if (this.observingWorkerTransfers) return;
    this.observingWorkerTransfers = true;
    this.channel.port2.on('message', data => this.ownTransferredPorts({ value: data }));
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Browser Worker positional transport boundary; only Node MessagePorts are transferred here.
  postMessage(message: unknown, transfer: Parameters<MessagePort['postMessage']>[1]) {
    if (this.terminated) throw new Error('Replay Worker has been physically disposed');
    this.hostMessages.push(message);
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
    this.channel.port1.close();
    this.channel.port2.close();
    for (const port of this.transferredPorts) port.close();
    this.transferredPorts.clear();
  }
}

export const TEST_ONLY = {
};
