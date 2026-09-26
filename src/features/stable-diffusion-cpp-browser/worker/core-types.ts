/* eslint-disable local-rules-named-args/require-named-args -- This file describes external generated ABI/host-helper signatures of an optional artifact, not Naidan-owned command signatures. */
/** The consumer boundary for the generated, fingerprinted ABI 2 host bindings.
 * Native pointers are bigint on BOTH Wasm widths. Record offsets are never duplicated here.
 * Positional calls below follow the upstream and optional host-helper contracts.
 */
export interface NativeApi {
  sd_ctx_params_init(pointer: bigint): Promise<void>;
  sd_img_gen_params_init(pointer: bigint): Promise<void>;
  new_sd_ctx(parameters: bigint): Promise<bigint>;
  free_sd_ctx(context: bigint): Promise<void>;
  sd_ctx_supports_image_generation(context: bigint): Promise<number>;
  sd_get_model_version_name(context: bigint): Promise<bigint>;
  sd_get_default_sample_method(context: bigint): Promise<number>;
  sd_get_default_scheduler(context: bigint, sampler: number): Promise<number>;
  str_to_sample_method(name: bigint): Promise<number>;
  str_to_scheduler(name: bigint): Promise<number>;
  sd_set_log_callback(callback: bigint, data: bigint): Promise<void>;
  sd_set_progress_callback(callback: bigint, data: bigint): Promise<void>;
  sd_set_preview_callback(callback: bigint, mode: number, interval: number, denoised: number, noisy: number, data: bigint): Promise<void>;
  sd_list_devices(buffer: bigint, bytes: bigint): Promise<bigint>;
  generate_image(context: bigint, parameters: bigint, imagesOut: bigint, countOut: bigint): Promise<number>;
  free_sd_images(images: bigint, count: number): Promise<void>;
}
export interface CoreModule {
  HEAPU8: Uint8Array<ArrayBuffer>;
  FS: { mkdir(path: string): unknown };
  addFunction(callback: (...args: (number | bigint)[]) => void, signature: string): number | bigint;
  removeFunction(pointer: number | bigint): void;
  _sdc_abi_version(): number;
  _sdc_model_io_capabilities?(): number;
}
export interface Core {
  module: CoreModule;
  api: NativeApi;
  readonly busy: boolean;
  pointerBytes: number;
  constant(name: string): number;
  alloc(bytes: number | bigint): bigint;
  free(pointer: bigint): void;
  recordSize(name: string): number;
  allocRecord(name: string): bigint;
  fieldAddress(name: string, pointer: bigint, field: string): bigint;
  getField(name: string, pointer: bigint, field: string): number | bigint;
  setField(name: string, pointer: bigint, field: string, value: number | bigint): void;
  bytes(pointer: bigint, length: number | bigint): Uint8Array<ArrayBuffer>;
  utf8(text: string): bigint;
  readUtf8(pointer: bigint, maximum?: number): string | null;
}
export type CoreFactory = (options: {
  wasmBinary: Uint8Array<ArrayBuffer>;
  locateFile(path: string): string;
  print(message: string): void;
  printErr(message: string): void;
  onAbort(reason: unknown): void;
}) => Promise<CoreModule>;
export interface HostHelpers {
  schema: { abiVersion: number, schemaSha256: string };
  attachCore(module: CoreModule, schema: object, options: { suspension: 'direct' | 'asyncify' }): Core;
  mountReadOnlyFile(core: Core, path: string, source: { size: number, read(destination: Uint8Array, offset: number): number }, options: { maxChunkBytes: number }): { path: string, remove(): void };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
