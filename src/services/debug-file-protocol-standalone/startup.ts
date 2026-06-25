import {
  debugReadFileProtocolStandaloneStartupState,
  type DebugFileProtocolStandaloneStartupCheckpointName,
  type DebugFileProtocolStandaloneStartupError,
} from './runtime-state';

/**
 * Append a Naidan-owned checkpoint to the optional standalone Debug timeline.
 * Core startup never reads this state. Recording is fail-open and becomes a
 * no-op in hosted builds where the standalone loader did not create the state.
 */
export function debugRecordFileProtocolStandaloneStartupCheckpoint({
  checkpoint,
  details,
}: {
  checkpoint: DebugFileProtocolStandaloneStartupCheckpointName,
  details: Readonly<Record<string, string | number | boolean>> | undefined,
}): void {
  try {
    const startupDebugState = debugReadFileProtocolStandaloneStartupState();
    if (startupDebugState === undefined) return;

    const now = performance.now();
    startupDebugState.checkpoint = checkpoint;
    startupDebugState.updatedAt = now;
    startupDebugState.documentReadyState = document.readyState;
    startupDebugState.checkpointHistory.push({
      source: 'naidan-app',
      name: checkpoint,
      at: now,
      documentReadyState: document.readyState,
      details,
    });
  } catch (error) {
    console.warn('[naidan] Failed to record standalone startup Debug checkpoint:', error);
  }
}

export function debugRecordFileProtocolStandaloneAppStartupFailure({ error }: {
  error: DebugFileProtocolStandaloneStartupError,
}): void {
  try {
    const startupDebugState = debugReadFileProtocolStandaloneStartupState();
    if (startupDebugState === undefined) return;
    startupDebugState.error = error;
    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'bootstrap-failed',
      details: { errorName: error.name },
    });
  } catch (debugError) {
    console.warn('[naidan] Failed to update standalone startup Debug state:', debugError);
  }
}
