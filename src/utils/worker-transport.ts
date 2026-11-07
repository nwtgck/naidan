import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION, READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION, type WorkerTransportCapability } from './worker-transport-capabilities';
export type { WorkerTransportCapability } from './worker-transport-capabilities';
import * as Comlink from 'comlink';
import { z } from 'zod';

export type WorkerRemote<Api> = Comlink.Remote<Api>;
export type WorkerProxy<T extends object> = T & Comlink.ProxyMarked;

declare const workerTransferMarker: unique symbol;
export interface WorkerTransferMarked {
  readonly [workerTransferMarker]: true,
}
export type WorkerTransfer<T extends object> = T & WorkerTransferMarked;

declare const workerCapabilityMarker: unique symbol;
export interface WorkerCapabilityMarked<Capability extends WorkerTransportCapability> {
  readonly [workerCapabilityMarker]: Capability,
}
export type WorkerCapability<
  T extends object,
  Capability extends WorkerTransportCapability,
> = T & WorkerCapabilityMarked<Capability>;

type WorkerServerArgument<T> =
  T extends WorkerCapabilityMarked<WorkerTransportCapability>
    ? Omit<T, keyof WorkerCapabilityMarked<WorkerTransportCapability> | keyof WorkerTransferMarked>
    : T extends WorkerTransferMarked
      ? Omit<T, keyof WorkerTransferMarked>
      : T extends Comlink.ProxyMarked
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors an external Comlink positional callback boundary.
        ? T extends (...args: infer Args) => infer Result
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserves the external Comlink positional callback signature.
          ? (...args: Args) => Result
          : Omit<T, keyof Comlink.ProxyMarked>
        : T;

export type WorkerServerApi<Api> = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors Worker RPC positional signatures declared at the Comlink boundary.
  [Key in keyof Api]: Api[Key] extends (...args: infer Args) => infer Result
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserves Worker RPC positional signatures while removing wire-only markers.
    ? (...args: { [Index in keyof Args]: WorkerServerArgument<Args[Index]> }) => Result
    : Api[Key];
};

export function wrapWorkerRemote<Api>({
  endpoint,
}: {
  endpoint: Comlink.Endpoint,
}): WorkerRemote<Api> {
  return Comlink.wrap<Api>(endpoint);
}

export function exposeWorkerRemote<Api>({
  api,
  endpoint,
}: {
  api: WorkerServerApi<Api>,
  endpoint: Comlink.Endpoint | undefined,
}): void {
  Comlink.expose(api, endpoint);
}

export function workerProxy<T extends object>({
  value,
}: {
  value: T,
}): WorkerProxy<T> {
  return Comlink.proxy(value);
}

export function workerTransfer<T extends object>({
  value,
  transferables,
}: {
  value: T,
  transferables: Transferable[],
}): WorkerTransfer<T> {
  return Comlink.transfer(value, transferables) as WorkerTransfer<T>;
}

/** Only this boundary can issue the wire marker. Checking the actual handles
 * avoids treating a handle-free request as evidence of handle cloning support. */
export async function workerCapability<
  T extends object,
  Capability extends WorkerTransportCapability,
>({ value, capability }: {
  value: T, capability: Capability,
}): Promise<WorkerCapability<T, Capability>> {
  let supported: boolean;
  switch (capability) {
  case FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION: {
    const handles = fileSystemHandlesIn({ value });
    supported = (await Promise.all(handles.map(handle => fileSystemHandleCloneSupport({ handle })))).every(Boolean);
    break;
  }
  case READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION:
    supported = await getReadableStreamTransferSupport() === 'supported';
    break;
  default: {
    const exhaustive: never = capability;
    throw new Error(`Unknown worker transport capability: ${String(exhaustive)}`);
  }
  }
  if (!supported) {
    throw new WorkerCapabilityUnavailableError({ capability });
  }
  return value as WorkerCapability<T, Capability>;
}

class WorkerCapabilityUnavailableError extends Error {
  readonly capability: WorkerTransportCapability;

  constructor({ capability }: { capability: WorkerTransportCapability }) {
    super(`Worker transport capability is unavailable: ${String(capability)}`);
    this.name = 'WorkerCapabilityUnavailableError';
    this.capability = capability;
  }
}

/** Choose a wire representation before invoking application code. Do not wrap
 * an RPC in a catch(DataCloneError): a remote failure must never replay writes. */
export async function prepareWorkerCapability<T extends object, Fallback, Capability extends WorkerTransportCapability>({ value, capability, fallback }: {
  value: T, capability: Capability, fallback: () => Promise<Fallback>,
}): Promise<WorkerCapability<T, Capability> | Fallback> {
  try {
    return await workerCapability({ value, capability });
  } catch (error) {
    if (!(error instanceof WorkerCapabilityUnavailableError) || error.capability !== capability) {
      throw error;
    }
    return fallback();
  }
}

function isFileSystemHandle(value: unknown): value is FileSystemHandle {
  return typeof value === 'object' && value !== null
    && 'kind' in value && (value.kind === 'file' || value.kind === 'directory')
    && 'name' in value && typeof value.name === 'string'
    && 'isSameEntry' in value && typeof value.isSameEntry === 'function';
}

/** Traverse containers, not model/audio bytes. Neither a File snapshot nor an
 * ArrayBuffer needs duplicating just to check the handles next to it. */
function fileSystemHandlesIn({ value }: { value: unknown }): FileSystemHandle[] {
  const pending: unknown[] = [value], seen = new Set<object>(), handles: FileSystemHandle[] = [];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (isFileSystemHandle(current)) {
      handles.push(current);
    } else if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer
      || (typeof Blob !== 'undefined' && current instanceof Blob)
      || current instanceof Date || current instanceof RegExp) {
      continue;
    } else if (current instanceof Map) {
      for (const [key, entry] of current) {
        pending.push(key, entry);
      }
    } else if (current instanceof Set) {
      for (const entry of current) {
        pending.push(entry);
      }
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        if (!descriptor.enumerable) {
          continue;
        }
        if (!('value' in descriptor)) {
          throw new TypeError('Worker capability payloads must not contain accessors');
        }
        pending.push(descriptor.value);
      }
    }
  }
  return handles;
}

// Per-object and per-realm: directory success never certifies a file handle,
// and permission/storage failures for one handle never poison other handles.
let fileSystemHandleSupport = new WeakMap<FileSystemHandle, Promise<boolean>>();

function fileSystemHandleCloneSupport({ handle }: { handle: FileSystemHandle }): Promise<boolean> {
  let pending = fileSystemHandleSupport.get(handle);
  if (!pending) {
    pending = detectFileSystemHandleCloneSupport({ handle });
    fileSystemHandleSupport.set(handle, pending);
  }
  return pending;
}

async function detectFileSystemHandleCloneSupport({ handle }: { handle: FileSystemHandle }): Promise<boolean> {
  if (typeof MessageChannel === 'undefined') {
    return false;
  }
  let channel: MessageChannel;
  try {
    channel = new MessageChannel();
  } catch {
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>(resolve => {
      timeout = setTimeout(() => resolve(false), 2000);
      channel.port2.onmessageerror = () => resolve(false);
      channel.port2.onmessage = (event: MessageEvent<unknown>) => {
        const clone = event.data;
        if (!isFileSystemHandle(clone) || clone.kind !== handle.kind || clone.name !== handle.name) {
          resolve(false);
          return;
        }
        void Promise.resolve().then(() => handle.isSameEntry(clone)).then(resolve, () => resolve(false));
      };
      try {
        channel.port2.start();
        channel.port1.postMessage(handle);
      } catch {
        resolve(false);
      }
    });
  } finally {
    clearTimeout(timeout);
    channel.port2.onmessage = null;
    channel.port2.onmessageerror = null;
    channel.port1.close();
    channel.port2.close();
  }
}

export function releaseWorkerRemote<Api>({
  remote,
}: {
  remote: WorkerRemote<Api>,
}): unknown {
  return remote[Comlink.releaseProxy]();
}

let readableStreamTransferSupport: Promise<'supported' | 'unsupported'> | undefined;

async function detectReadableStreamTransferSupport(): Promise<'supported' | 'unsupported'> {
  if (typeof ReadableStream === 'undefined' || typeof structuredClone === 'undefined') {
    return 'unsupported';
  }
  const probe = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new Uint8Array([78]));
      controller.close();
    },
  });
  try {
    const transferred = structuredClone(probe, { transfer: [probe] });
    const reader = transferred.getReader();
    try {
      const first = await reader.read();
      const end = await reader.read();
      return !first.done && Object.prototype.toString.call(first.value) === '[object Uint8Array]' && first.value.length === 1 && first.value[0] === 78 && end.done ? 'supported' : 'unsupported';
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch {
    await probe.cancel().catch(() => undefined);
    return 'unsupported';
  }
}

export function getReadableStreamTransferSupport(): Promise<'supported' | 'unsupported'> {
  readableStreamTransferSupport ??= detectReadableStreamTransferSupport();
  return readableStreamTransferSupport;
}

/** One-way, schema-checked notifications for synchronous native work. Unlike a
 * proxied RPC callback this creates no response promise/acknowledgement queue.
 * An omitted endpoint means the current dedicated Worker, as for Comlink expose.
 * Consumers own rate/size limits and must never use this as an unchecked RPC. */
export function postWorkerNotification<T>({ endpoint, schema, value }: {
  endpoint: Pick<Comlink.Endpoint, 'postMessage'> | undefined,
  schema: import('zod').ZodType<T>, value: T,
}): void {
  try {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      (endpoint ?? globalThis as unknown as Comlink.Endpoint).postMessage(parsed.data);
    }
  } catch { /* Notification failure must not unwind native execution. */ }
}

export function subscribeWorkerNotifications<T>({ endpoint, schema, listener }: {
  endpoint: Comlink.Endpoint | undefined, schema: import('zod').ZodType<T>, listener: ({ value }: { value: T }) => void,
}): () => void {
  // Undefined is the current dedicated Worker, matching postWorkerNotification.
  const target = endpoint ?? globalThis as unknown as Comlink.Endpoint;
  let active = true;
  const receive: EventListener = event => {
    if (!active) {
      return;
    }
    try {
      const parsed = schema.safeParse((event as MessageEvent<unknown>).data);
      if (parsed.success) {
        listener({ value: parsed.data });
      }
    } catch { /* Neither malformed telemetry nor a renderer controls the Worker. */ }
  };
  target.addEventListener('message', receive);
  target.start?.();
  return () => {
    active = false;
    target.removeEventListener('message', receive);
  };
}

/** A schema-checked, single-owner MessagePort boundary for byte/control protocols.
 * Keep raw postMessage/listeners in this audited module, not in feature code.
 */
export function createValidatedMessagePort<Incoming extends z.ZodType, Outgoing extends z.ZodType>({
  port, incomingSchema, outgoingSchema, onMessage, onError,
}: {
  port: MessagePort,
  incomingSchema: Incoming,
  outgoingSchema: Outgoing,
  onMessage: ({ message }: { message: z.infer<Incoming> }) => void | Promise<void>,
  onError: ({ reason }: { reason: unknown }) => void,
}): {
  send: ({ message, transferables }: { message: z.input<Outgoing>, transferables: Transferable[] }) => void,
  close: () => void,
} {
  let closed = false;
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (closed) {
      return;
    }
    try {
      const result = onMessage({ message: incomingSchema.parse(event.data) });
      if (result) {
        void result.catch(reason => onError({ reason }));
      }
    } catch (reason) {
      onError({ reason });
    }
  };
  port.onmessageerror = () => onError({ reason: new Error('Invalid worker message') });
  port.start();
  return {
    send({ message, transferables }) {
      if (closed) {
        return;
      }
      try {
        port.postMessage(outgoingSchema.parse(message), transferables);
      } catch (reason) {
        // Close before notifying: error handlers may try to tell the peer that
        // the stream failed. A broken port must not recurse through send().
        closed = true;
        port.onmessage = null;
        port.onmessageerror = null;
        port.close();
        onError({ reason });
      }
    },
    close() {
      closed = true;
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  detectReadableStreamTransferSupport,
  detectFileSystemHandleCloneSupport,
  fileSystemHandlesIn,
  resetCapabilitySupport() {
    fileSystemHandleSupport = new WeakMap();
    readableStreamTransferSupport = undefined;
  },
};
