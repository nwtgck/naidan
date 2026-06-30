declare global {
  type DebugFileProtocolStandaloneGlobalDiagnostics = import(
    './features/file-protocol-standalone/debug/runtime-state'
  ).DebugFileProtocolStandaloneGlobalDiagnostics;

  var __FILE_PROTOCOL_STANDALONE__: Readonly<{
    getDiagnostics(): DebugFileProtocolStandaloneGlobalDiagnostics,
  }> | undefined;
}

export {};
