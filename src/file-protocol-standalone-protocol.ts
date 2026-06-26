/**
 * Stable names shared by generated standalone runtime scripts, build-time
 * validation, and application-side Debug tooling. Changing one of these values
 * is a protocol migration rather than an internal rename.
 */
export const FILE_PROTOCOL_STANDALONE_GLOBAL_NAME = '__FILE_PROTOCOL_STANDALONE__' as const;

export const DEBUG_FILE_PROTOCOL_STANDALONE_STARTUP_FORMAT = 'file-protocol-standalone-startup-v2' as const;
export const DEBUG_FILE_PROTOCOL_STANDALONE_DIAGNOSTICS_FORMAT = 'file-protocol-standalone-diagnostics-v2' as const;
export const DEBUG_FILE_PROTOCOL_STANDALONE_BUILD_REPORT_FORMAT = 'file-protocol-standalone-build-report-v5' as const;

export const FILE_PROTOCOL_STANDALONE_ELEMENT_IDS = {
  systemJsRuntime: 'file-protocol-standalone-systemjs-runtime',
  systemJsFilePatch: 'file-protocol-standalone-systemjs-file-patch',
  systemJsRetryHook: 'file-protocol-standalone-systemjs-retry-hook',
  workerManifest: 'file-protocol-standalone-worker-manifest',
  entryBootstrap: 'file-protocol-standalone-entry',
} as const;

export const FILE_PROTOCOL_STANDALONE_GENERATED_ELEMENT_IDS = [
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime,
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch,
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook,
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.workerManifest,
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap,
] as const;

export const FILE_PROTOCOL_STANDALONE_EXECUTABLE_ELEMENT_IDS = [
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRuntime,
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsFilePatch,
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.systemJsRetryHook,
  FILE_PROTOCOL_STANDALONE_ELEMENT_IDS.entryBootstrap,
] as const;
