import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

/** Emulate only native-handle cloning. Other messages still use Node's real
 * MessagePorts, so Comlink and stream/transfer-list tests are not bypassed. */
export function installHandleCloneProbe({ mode = () => 'supported' }: {
  mode?: ({ handle }: { handle: FileSystemHandle }) => 'supported' | 'unsupported' | 'messageerror' | 'timeout' | 'malformed',
} = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
  const channels: NodeMessageChannel[] = [];
  const probes: FileSystemHandle[] = [];
  let closedPorts = 0;
  class ProbeMessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;

    constructor() {
      const channel = new NodeMessageChannel();
      channels.push(channel);
      this.port1 = channel.port1 as unknown as MessagePort;
      this.port2 = channel.port2 as unknown as MessagePort;
      // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Test-only emulation of native handle structured cloning.
      const post = this.port1.postMessage.bind(this.port1);
      // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Test-only native MessagePort interception.
      this.port1.postMessage = (value: unknown, options?: Transferable[] | StructuredSerializeOptions) => {
        if (typeof value !== 'object' || value === null || !('kind' in value) || !('isSameEntry' in value)) {
          post(value, options as StructuredSerializeOptions);
          return;
        }
        const handle = value as FileSystemHandle;
        probes.push(handle);
        const result = mode({ handle });
        const deliver = ({ value }: { value: unknown }) => queueMicrotask(() => {
          // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Test-only delivery of an emulated native handle.
          this.port2.onmessage?.call(this.port2, { data: value } as MessageEvent);
        });
        switch (result) {
        case 'unsupported': throw new DOMException('Native handle cannot be cloned', 'DataCloneError');
        case 'supported': deliver({ value: handle });
          break;
        case 'malformed': deliver({ value: { kind: handle.kind, name: handle.name } });
          break;
        case 'messageerror': queueMicrotask(() => this.port2.onmessageerror?.call(this.port2, new MessageEvent('messageerror')));
          break;
        case 'timeout': break;
        default: {
          const exhaustive: never = result;
          throw new Error(String(exhaustive));
        }
        }
      };
      for (const port of [this.port1, this.port2]) {
        const close = port.close.bind(port);
        let closed = false;
        port.close = () => {
          if (!closed) {
            closed = true;
            closedPorts++;
          }
          close();
        };
      }
    }
  }
  Object.defineProperty(globalThis, 'MessageChannel', { configurable: true, writable: true, value: ProbeMessageChannel });
  return {
    probes,
    get closedPorts() {
      return closedPorts;
    },
    [Symbol.dispose]() {
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
      if (original) {
        Object.defineProperty(globalThis, 'MessageChannel', original);
      } else {
        Reflect.deleteProperty(globalThis, 'MessageChannel');
      }
    },
  };
}

export function probeHandle({ kind = 'file', name = 'model.gguf' }: { kind?: 'file' | 'directory', name?: string } = {}): FileSystemHandle {
  const handle: FileSystemHandle = {
    kind,
    name,
    isSameEntry: async other => other === handle,
  };
  return handle;
}

export const TEST_ONLY = {
};
