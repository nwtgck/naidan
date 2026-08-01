import * as Comlink from 'comlink';

import { createAdvancedTextEditorV3Worker } from '@/features/advanced-text-editor-v3/worker/impl';
import { createProductionHizoFSBenchmarkRuntimePort } from '@/features/debug-hizofs/benchmark/production-runtime-port';
import { createHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-impl';
import { createFileExplorerWorker } from '@/features/file-explorer/worker/impl';
import { createHighlightWorker } from '@/features/highlight/worker/impl';
import type { IWorkerHub } from './worker-hub.types';
import { createGlobalSearchWorker } from '@/features/global-search/worker/impl';
import { openNaidanStorageDirectoryWorkerMount } from '@/00-storage/service/naidan-opfs/worker-mount-runtime';
import { createWeshWorker } from '@/features/wesh/worker/impl';

export function createStandaloneWorkerHub(): IWorkerHub {
  return {
    wesh: Comlink.proxy(createWeshWorker({
      openStorageDirectoryWorkerMount: openNaidanStorageDirectoryWorkerMount,
    })),
    hizoFSBenchmark: Comlink.proxy(createHizoFSBenchmarkWorker({
      runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
    })),
    globalSearch: Comlink.proxy(createGlobalSearchWorker()),
    fileExplorer: Comlink.proxy(createFileExplorerWorker()),
    advancedTextEditorV3: Comlink.proxy(createAdvancedTextEditorV3Worker()),
    highlight: Comlink.proxy(createHighlightWorker()),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
