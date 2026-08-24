export type StandaloneWorkerNameDiagnostics = Readonly<{
  workersCreated: number,
  workersTerminated: number,
  activeWorkers: number,
  initializationAttempts: number,
  initializationSuccesses: number,
  initializationFailures: number,
  initializationTimeouts: number,
}>;

export type StandaloneWorkerRuntimeDiagnostics = Readonly<{
  bootstrapObjectUrlStatus: 'idle' | 'warmup-scheduled' | 'ready',
  bootstrapObjectUrlsCreated: number,
  bootstrapObjectUrlsRevoked: number,
  warmupSchedules: number,
  warmupRuns: number,
  workerConstructorFailures: number,
  workersCreated: number,
  workersTerminated: number,
  activeWorkers: number,
  terminateInstrumentationFailures: number,
  initializationAttempts: number,
  initializationSuccesses: number,
  initializationFailures: number,
  initializationTimeouts: number,
  workersByName: Readonly<Record<string, StandaloneWorkerNameDiagnostics>>,
}>;

export type StandaloneWorkerCreateOptions = Readonly<{
  name?: string,
  startupTimeoutMs?: number,
}>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
