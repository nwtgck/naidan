// TODO(hizofs-v1:I0005): Remove HIZOFS_TRIAL_DEBUG_001 after the user manual enable trial converges.
export const HIZOFS_TRIAL_DEBUG_MARKER = 'HIZOFS_TRIAL_DEBUG_001';

type TrialError = Readonly<{
  errorCode: string | undefined;
  errorMessage: string;
  errorName: string;
  errorPath: string | undefined;
}>;

export type NativeEnableTrialStage = 'advance_transition' | 'prepare_transition_runtime' | 'start_persistence_transition';

export type HizoFSTrialDebugEvent =
  | Readonly<{
      event: 'native_enable';
      fileSystemId: string;
      operationId: string;
      stage:
        | 'target_created'
        | 'persistence_transition_started'
        | 'runtime_prepared'
        | 'copying'
        | 'verifying'
        | 'authority_switched'
        | 'retired_cleanup'
        | 'stable';
    }>
  | Readonly<{
      event: 'native_enable_failure';
      failure: TrialError;
      fileSystemId: string;
      operationId: string;
      stage: NativeEnableTrialStage;
    }>
  | Readonly<{
      event: 'unlock';
      fileSystemId: string | undefined;
      stage: 'started' | 'authority_opened' | 'backend_installed';
    }>
  | Readonly<{
      event: 'retired_plain_cleanup';
      fileSystemId: string;
      remainingEntryCount: number | undefined;
      removedEntryCount: number | undefined;
      stage: 'scheduled' | 'plain_namespace_in_use' | 'started' | 'completed' | 'failed';
      failure: TrialError | undefined;
    }>;

function projectTrialError({ cause }: { cause: unknown }): TrialError {
  if (typeof cause !== 'object' || cause === null) {
    return {
      errorCode: undefined,
      errorMessage: String(cause),
      errorName: typeof cause,
      errorPath: undefined,
    };
  }
  const detailed = cause as Readonly<{
    code?: unknown;
    message?: unknown;
    name?: unknown;
    path?: unknown;
  }>;
  return {
    errorCode: typeof detailed.code === 'string' ? detailed.code : undefined,
    errorMessage: typeof detailed.message === 'string' ? detailed.message : String(cause),
    errorName: typeof detailed.name === 'string' ? detailed.name : 'Error',
    errorPath: typeof detailed.path === 'string' ? detailed.path : undefined,
  };
}

export function reportHizoFSTrialDebug({ detail, level }: {
  detail: HizoFSTrialDebugEvent;
  level: 'info' | 'warn';
}): void {
  if (!import.meta.env.DEV) return;
  switch (level) {
  case 'info':
    console.info(`[${HIZOFS_TRIAL_DEBUG_MARKER}]`, detail);
    return;
  case 'warn':
    console.warn(`[${HIZOFS_TRIAL_DEBUG_MARKER}]`, detail);
    return;
  default: return level satisfies never;
  }
}

export function reportHizoFSTrialFailure({ cause, detail }: {
  cause: unknown;
  detail: Omit<Extract<HizoFSTrialDebugEvent, { event: 'native_enable_failure' }>, 'failure'>;
}): void {
  reportHizoFSTrialDebug({
    detail: { ...detail, failure: projectTrialError({ cause }) },
    level: 'warn',
  });
}

export function reportRetiredPlainCleanupFailure({ cause, fileSystemId, remainingEntryCount }: {
  cause: unknown;
  fileSystemId: string;
  remainingEntryCount: number | undefined;
}): void {
  reportHizoFSTrialDebug({
    detail: {
      event: 'retired_plain_cleanup',
      failure: projectTrialError({ cause }),
      fileSystemId,
      remainingEntryCount,
      removedEntryCount: undefined,
      stage: 'failed',
    },
    level: 'warn',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
