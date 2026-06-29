import * as Comlink from 'comlink';

import { createAdvancedTextEditorV3Worker } from '@/features/advanced-text-editor-v3/worker/impl';
import { createFileExplorerWorker } from '@/features/file-explorer/worker/impl';
import { createHighlightWorker } from '@/features/highlight/worker/impl';
import type { IWorkerHub } from './worker-hub.types';
import { createGlobalSearchWorker } from '@/features/global-search/worker/impl';
import { createWeshWorker } from '@/features/wesh/worker/impl';

export function createStandaloneWorkerHub(): IWorkerHub {
  return {
    wesh: Comlink.proxy(createWeshWorker()),
    globalSearch: Comlink.proxy(createGlobalSearchWorker()),
    fileExplorer: Comlink.proxy(createFileExplorerWorker()),
    advancedTextEditorV3: Comlink.proxy(createAdvancedTextEditorV3Worker()),
    highlight: Comlink.proxy(createHighlightWorker()),
  };
}
