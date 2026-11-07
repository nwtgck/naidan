import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from '../../../src/utils/worker-transport-capabilities';
import type * as Comlink from "comlink";
import { AutoTokenizer } from "@huggingface/transformers";

declare function wrapWorkerRemote<Api>(endpoint: Comlink.Endpoint): Comlink.Remote<Api>;
declare const endpoint: Comlink.Endpoint;

type WorkerProxy<T extends object> = T & Comlink.ProxyMarked;

interface SafeApi {
  run(request: { id: string, values: number[], buffer: ArrayBuffer }): Promise<{ ok: boolean }>;
}
wrapWorkerRemote<SafeApi>(endpoint);

interface ProxyApi {
  run(callback: WorkerProxy<(value: number) => void>): Promise<void>;
}
wrapWorkerRemote<ProxyApi>(endpoint);

interface AsyncProxyApi {
  run(callback: WorkerProxy<(value: number) => void | Promise<void>>): Promise<void>;
}
wrapWorkerRemote<AsyncProxyApi>(endpoint);

interface UnknownApi {
  run(request: { payload: Record<string, unknown> }): Promise<void>;
}
wrapWorkerRemote<UnknownApi>(endpoint);

interface NestedFunctionApi {
  run(request: { nested: { callback: () => void } }): Promise<void>;
}
wrapWorkerRemote<NestedFunctionApi>(endpoint);

interface CapabilityApi {
  run(request: { handle: FileSystemDirectoryHandle }): Promise<void>;
}
wrapWorkerRemote<CapabilityApi>(endpoint);

import type { WorkerCapability } from '../../../src/utils/worker-transport';
interface BrandedCapabilityApi {
  run(request: WorkerCapability<{ handle: FileSystemDirectoryHandle; label: string }, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>): Promise<void>;
}
wrapWorkerRemote<BrandedCapabilityApi>(endpoint);
interface UnsafeBrandedCapabilityApi {
  run(request: WorkerCapability<{ handle: FileSystemDirectoryHandle; callback: () => void }, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>): Promise<void>;
}
wrapWorkerRemote<UnsafeBrandedCapabilityApi>(endpoint);
interface NestedCapabilityApi {
  run(request: { nested: WorkerCapability<{ handle: FileSystemDirectoryHandle }, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION> }): Promise<void>;
}
wrapWorkerRemote<NestedCapabilityApi>(endpoint);

interface NestedProxyApi {
  run(request: { callback: WorkerProxy<(value: number) => void> }): Promise<void>;
}
wrapWorkerRemote<NestedProxyApi>(endpoint);

interface ExternalApi {
  run(request: { endpoint: Comlink.Endpoint }): Promise<void>;
}
wrapWorkerRemote<ExternalApi>(endpoint);

type ExternalTokenizerOptions = Parameters<typeof AutoTokenizer.from_pretrained>[1];
interface ThirdPartyOptionsApi {
  run(request: { options: ExternalTokenizerOptions }): Promise<void>;
}
wrapWorkerRemote<ThirdPartyOptionsApi>(endpoint);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface JsonObjectApi {
  run(request: { payload: { [key: string]: JsonValue } }): Promise<void>;
}
wrapWorkerRemote<JsonObjectApi>(endpoint);

interface StructuralUtilitySource {
  id: string;
  payload: { ok: boolean };
  omitted: string;
}
interface StructuralUtilityApi {
  run(request: Omit<StructuralUtilitySource, "omitted">): Promise<Readonly<Pick<StructuralUtilitySource, "id">>>;
}
wrapWorkerRemote<StructuralUtilityApi>(endpoint);


declare const workerTransferMarker: unique symbol;
type WorkerTransfer<T extends object> = T & { readonly [workerTransferMarker]: true };
interface RawTransferApi {
  attach(port: MessagePort): Promise<void>;
}
wrapWorkerRemote<RawTransferApi>(endpoint);
interface BrandedTransferApi {
  attach(request: WorkerTransfer<{ port: MessagePort; label: string }>): Promise<void>;
}
wrapWorkerRemote<BrandedTransferApi>(endpoint);
interface UnsafeBrandedTransferApi {
  attach(request: WorkerTransfer<{ port: MessagePort; callback: () => void }>): Promise<void>;
}
wrapWorkerRemote<UnsafeBrandedTransferApi>(endpoint);
interface NestedTransferApi {
  attach(request: { nested: WorkerTransfer<{ port: MessagePort }> }): Promise<void>;
}
wrapWorkerRemote<NestedTransferApi>(endpoint);


interface MapSetApi {
  run(request: { lookup: Map<string, number>, ids: Set<string> }): Promise<void>;
}
wrapWorkerRemote<MapSetApi>(endpoint);

interface GenericApi {
  run<T>(value: T): Promise<void>;
}
wrapWorkerRemote<GenericApi>(endpoint);

interface OverloadedApi {
  run(value: string): Promise<void>;
  run(value: () => void): Promise<void>;
}
wrapWorkerRemote<OverloadedApi>(endpoint);


interface UnsafeProxyPayloadApi {
  run(callback: WorkerProxy<(payload: { nested: { callback: () => void } }) => void>): Promise<void>;
}
wrapWorkerRemote<UnsafeProxyPayloadApi>(endpoint);

interface UnsafeProxyReader {
  read(id: string): Promise<{ nested: { callback: () => void } }>;
}
interface UnsafeProxyObjectApi {
  configure(reader: WorkerProxy<UnsafeProxyReader>): Promise<void>;
}
wrapWorkerRemote<UnsafeProxyObjectApi>(endpoint);


interface AliasedUnsafeApi {
  run(request: { nested: { callback: () => void } }): Promise<void>;
}
const aliasedWrapWorkerRemote = wrapWorkerRemote;
aliasedWrapWorkerRemote<AliasedUnsafeApi>(endpoint);
const workerTransportFacade = { wrap: wrapWorkerRemote };
workerTransportFacade.wrap<AliasedUnsafeApi>(endpoint);

function identity<T>(value: T): T { return value; }
const identityWrappedWorkerRemote = identity(wrapWorkerRemote);
identityWrappedWorkerRemote<AliasedUnsafeApi>(endpoint);
