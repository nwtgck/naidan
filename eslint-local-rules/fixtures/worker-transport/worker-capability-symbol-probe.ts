import { wrapWorkerRemote, type WorkerCapability } from '../../../src/utils/worker-transport';
import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION as detectedHandleCloning } from '../../../src/utils/worker-transport-capabilities';
import * as capabilities from '../../../src/utils/worker-transport-capabilities';
declare const endpoint: MessagePort;
const fake = Symbol('file-system-handle-clone');
const FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION = Symbol('file-system-handle-clone');
const widened: symbol = detectedHandleCloning;
interface Canonical {
  alias(input: WorkerCapability<{ handle: FileSystemFileHandle }, typeof detectedHandleCloning>): Promise<void>;
  namespace(input: WorkerCapability<{ handle: FileSystemDirectoryHandle }, typeof capabilities.FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>): Promise<void>;
}
interface Fake {
  // @ts-expect-error A matching Symbol description is not a canonical capability.
  run(input: WorkerCapability<{ handle: FileSystemFileHandle }, typeof fake>): Promise<void>;
}
interface SameSpelling {
  // @ts-expect-error A same-named constant in another module is not canonical.
  run(input: WorkerCapability<{ handle: FileSystemFileHandle }, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>): Promise<void>;
}
interface Widened {
  // @ts-expect-error A generic symbol is not proof of a specific capability.
  run(input: WorkerCapability<{ handle: FileSystemFileHandle }, typeof widened>): Promise<void>;
}
interface Legacy {
  // @ts-expect-error Legacy string markers must no longer grant permission.
  run(input: WorkerCapability<{ handle: FileSystemFileHandle }, 'file-system-handle-clone'>): Promise<void>;
}
declare const workerCapabilityMarker: unique symbol;
interface CounterfeitBrand { readonly [workerCapabilityMarker]: typeof detectedHandleCloning }
interface Counterfeit { run(input: { handle: FileSystemFileHandle } & CounterfeitBrand): Promise<void> }
interface UnsafePortable { run(input: { kind: 'portable'; captured: { file: File; handle: FileSystemFileHandle } }): Promise<void> }
wrapWorkerRemote<Canonical>({ endpoint });
wrapWorkerRemote<Fake>({ endpoint });
wrapWorkerRemote<SameSpelling>({ endpoint });
wrapWorkerRemote<Widened>({ endpoint });
wrapWorkerRemote<Legacy>({ endpoint });
wrapWorkerRemote<Counterfeit>({ endpoint });
wrapWorkerRemote<UnsafePortable>({ endpoint });
