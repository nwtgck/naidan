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

declare module 'virtual:file-protocol-standalone/worker/llama-cpp-browser' {
  export function createStandaloneWorker(): Promise<Worker>;
}
declare module 'virtual:file-protocol-standalone/worker/llama-cpp-browser-download' {
  export function createStandaloneWorker(): Promise<Worker>;
}
declare module 'virtual:file-protocol-standalone/binary/llama-cpp-browser' {
  export const base64: string;
  export const byteLength: number;
  export const sha256: string;
}

declare module 'virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi' {
  export const base64: string;
  export const byteLength: number;
  export const sha256: string;
}
