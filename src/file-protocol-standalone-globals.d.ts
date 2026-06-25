declare global {
  type DebugFileProtocolStandaloneGlobalDiagnostics = import(
    './services/debug-file-protocol-standalone/runtime-state'
  ).DebugFileProtocolStandaloneGlobalDiagnostics;

  var __FILE_PROTOCOL_STANDALONE__: Readonly<{
    getDiagnostics(): DebugFileProtocolStandaloneGlobalDiagnostics,
  }> | undefined;
}

export {};
