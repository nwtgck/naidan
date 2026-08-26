declare module 'virtual:naidan-standalone-worker-runtime' {
  import type { StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';

  export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics;
  export function scheduleStandaloneWorkerBootstrapWarmup(): void;
  export function disposeStandaloneWorkerBootstrap(): void;
}

declare module 'virtual:file-protocol-standalone/worker/advanced-text-editor-v3' {
  import type { StandaloneWorkerCreateOptions, StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';

  export function createStandaloneWorker(options?: StandaloneWorkerCreateOptions): Promise<Worker>;
  export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics;
  export function scheduleStandaloneWorkerBootstrapWarmup(): void;
  export function disposeStandaloneWorkerBootstrap(): void;
}

declare module 'virtual:file-protocol-standalone/worker/highlight' {
  import type { StandaloneWorkerCreateOptions, StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';

  export function createStandaloneWorker(options?: StandaloneWorkerCreateOptions): Promise<Worker>;
  export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics;
  export function scheduleStandaloneWorkerBootstrapWarmup(): void;
  export function disposeStandaloneWorkerBootstrap(): void;
}

declare module 'virtual:file-protocol-standalone/worker/wesh' {
  import type { StandaloneWorkerCreateOptions, StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';

  export function createStandaloneWorker(options?: StandaloneWorkerCreateOptions): Promise<Worker>;
  export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics;
  export function scheduleStandaloneWorkerBootstrapWarmup(): void;
  export function disposeStandaloneWorkerBootstrap(): void;
}

declare module 'virtual:file-protocol-standalone/worker/global-search' {
  import type { StandaloneWorkerCreateOptions, StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';

  export function createStandaloneWorker(options?: StandaloneWorkerCreateOptions): Promise<Worker>;
  export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics;
  export function scheduleStandaloneWorkerBootstrapWarmup(): void;
  export function disposeStandaloneWorkerBootstrap(): void;
}

declare module 'virtual:file-protocol-standalone/worker/file-explorer' {
  import type { StandaloneWorkerCreateOptions, StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';

  export function createStandaloneWorker(options?: StandaloneWorkerCreateOptions): Promise<Worker>;
  export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics;
  export function scheduleStandaloneWorkerBootstrapWarmup(): void;
  export function disposeStandaloneWorkerBootstrap(): void;
}

declare module 'virtual:file-protocol-standalone/worker/hizofs-benchmark' {
  import type { StandaloneWorkerCreateOptions, StandaloneWorkerRuntimeDiagnostics } from '@/features/file-protocol-standalone/worker/standalone-worker-runtime.types';

  export function createStandaloneWorker(options?: StandaloneWorkerCreateOptions): Promise<Worker>;
  export function debugGetStandaloneWorkerRuntimeDiagnostics(): StandaloneWorkerRuntimeDiagnostics;
  export function scheduleStandaloneWorkerBootstrapWarmup(): void;
  export function disposeStandaloneWorkerBootstrap(): void;
}
