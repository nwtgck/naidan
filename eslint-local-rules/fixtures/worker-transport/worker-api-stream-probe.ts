import { wrapWorkerRemote, type WorkerCapability, type WorkerTransfer } from '../../../src/utils/worker-transport';

type TransferredStream<T> = WorkerTransfer<WorkerCapability<ReadableStream<T>, 'readable-stream-transfer'>>;
interface SafeStreamApi {
  consume(stream: TransferredStream<Uint8Array<ArrayBuffer>>): Promise<void>,
  wrapped(request: WorkerTransfer<WorkerCapability<{ stream: ReadableStream<Uint8Array<ArrayBuffer>> }, 'readable-stream-transfer'>>): Promise<void>,
  response(): Promise<TransferredStream<Uint8Array<ArrayBuffer>>>,
}
interface UnsafeStreamApi {
  raw(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<void>,
  transferOnly(stream: WorkerTransfer<ReadableStream<Uint8Array<ArrayBuffer>>>): Promise<void>,
  capabilityOnly(stream: WorkerCapability<ReadableStream<Uint8Array<ArrayBuffer>>, 'readable-stream-transfer'>): Promise<void>,
  wrongCapability(stream: WorkerTransfer<WorkerCapability<ReadableStream<Uint8Array<ArrayBuffer>>, 'file-system-handle-clone'>>): Promise<void>,
  unknownChunk(stream: TransferredStream<unknown>): Promise<void>,
  callbackChunk(stream: TransferredStream<() => void>): Promise<void>,
  sharedChunk(stream: TransferredStream<Uint8Array<SharedArrayBuffer>>): Promise<void>,
  transferOnlyResponse(): Promise<WorkerTransfer<ReadableStream<Uint8Array<ArrayBuffer>>>>,
  capabilityOnlyResponse(): Promise<WorkerCapability<ReadableStream<Uint8Array<ArrayBuffer>>, 'readable-stream-transfer'>>,
}
namespace Impostor {
  export interface ReadableStream<T> { value: T, callback: () => void }
}
interface ImpostorStreamApi {
  consume(stream: WorkerTransfer<WorkerCapability<Impostor.ReadableStream<string>, 'readable-stream-transfer'>>): Promise<void>,
}
wrapWorkerRemote<SafeStreamApi>({ endpoint: new MessageChannel().port1 });
wrapWorkerRemote<UnsafeStreamApi>({ endpoint: new MessageChannel().port1 });
wrapWorkerRemote<ImpostorStreamApi>({ endpoint: new MessageChannel().port1 });
