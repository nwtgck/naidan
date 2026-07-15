import * as Comlink from 'comlink';

import { createAdvancedTextEditorV3Worker } from '@/features/advanced-text-editor-v3/worker/impl';
import { createHizoFSInspectionWorker } from '@/features/debug-hizofs/worker/impl';
import { createOpfsEncryptionWorker } from '@/00-storage/service/opfs-encryption/worker/impl';
import { createFileExplorerWorker } from '@/features/file-explorer/worker/impl';
import { createHighlightWorker } from '@/features/highlight/worker/impl';
import type { IWorkerHub } from './worker-hub.types';
import { createGlobalSearchWorker } from '@/features/global-search/worker/impl';
import { createWeshWorker } from '@/features/wesh/worker/impl';

export function createStandaloneWorkerHub(): IWorkerHub {
  return {
    wesh: Comlink.proxy(createWeshWorker()),
    hizoFSInspection: Comlink.proxy(createHizoFSInspectionWorker()),
    opfsEncryption: Comlink.proxy(createOpfsEncryptionWorker()),
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
