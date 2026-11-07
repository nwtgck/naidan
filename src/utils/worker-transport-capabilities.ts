/** These are requirements, not evidence of browser support. Use workerCapability
 * (or prepareWorkerCapability) to check the actual transport before branding data.
 * Symbols stay in this realm; they must never be included in a wire payload. */
export const FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION = Symbol('file-system-handle-clone');
export const READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION = Symbol('readable-stream-transfer');

export type WorkerTransportCapability =
  | typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION
  | typeof READABLE_STREAM_TRANSFER_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION;

export const TEST_ONLY = {
};
