export async function createStandaloneWorker(): Promise<Worker> {
  throw new Error('The split Worker constructor is not used by dependency-injected unit tests.');
}
export function debugGetStandaloneWorkerRuntimeDiagnostics(): never {
  throw new Error('The split Worker diagnostics reader is not used by dependency-injected unit tests.');
}
export function scheduleStandaloneWorkerBootstrapWarmup(): void {}
export function disposeStandaloneWorkerBootstrap(): void {}
