import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION, READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from '../../../src/utils/worker-transport-capabilities';
import { wrapWorkerRemote, type WorkerCapability, type WorkerTransfer } from '../../../src/utils/worker-transport';

type TransferredStream<T> = WorkerTransfer<WorkerCapability<ReadableStream<T>, typeof READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>>;
interface SafeStreamApi {
  consume(stream: TransferredStream<Uint8Array<ArrayBuffer>>): Promise<void>,
  wrapped(request: WorkerTransfer<WorkerCapability<{ stream: ReadableStream<Uint8Array<ArrayBuffer>> }, typeof READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>>): Promise<void>,
  response(): Promise<TransferredStream<Uint8Array<ArrayBuffer>>>,
}
interface UnsafeStreamApi {
  raw(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<void>,
  transferOnly(stream: WorkerTransfer<ReadableStream<Uint8Array<ArrayBuffer>>>): Promise<void>,
  capabilityOnly(stream: WorkerCapability<ReadableStream<Uint8Array<ArrayBuffer>>, typeof READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>): Promise<void>,
  wrongCapability(stream: WorkerTransfer<WorkerCapability<ReadableStream<Uint8Array<ArrayBuffer>>, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>>): Promise<void>,
  unknownChunk(stream: TransferredStream<unknown>): Promise<void>,
  callbackChunk(stream: TransferredStream<() => void>): Promise<void>,
  sharedChunk(stream: TransferredStream<Uint8Array<SharedArrayBuffer>>): Promise<void>,
  transferOnlyResponse(): Promise<WorkerTransfer<ReadableStream<Uint8Array<ArrayBuffer>>>>,
  capabilityOnlyResponse(): Promise<WorkerCapability<ReadableStream<Uint8Array<ArrayBuffer>>, typeof READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>>,
}
namespace Impostor {
  export interface ReadableStream<T> { value: T, callback: () => void }
}
interface ImpostorStreamApi {
  consume(stream: WorkerTransfer<WorkerCapability<Impostor.ReadableStream<string>, typeof READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>>): Promise<void>,
}
wrapWorkerRemote<SafeStreamApi>({ endpoint: new MessageChannel().port1 });
wrapWorkerRemote<UnsafeStreamApi>({ endpoint: new MessageChannel().port1 });
wrapWorkerRemote<ImpostorStreamApi>({ endpoint: new MessageChannel().port1 });
