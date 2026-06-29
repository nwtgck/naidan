import type { IAdvancedTextEditorV3Worker } from '@/features/advanced-text-editor-v3/worker/types';
import type * as Comlink from 'comlink';
import type { IFileExplorerWorker } from '@/features/file-explorer/worker/types';
import type { IGlobalSearchWorker } from '@/features/global-search/worker/types';
import type { IHighlightWorker } from '@/features/highlight/worker/types';
import type { IWeshWorker } from '@/features/wesh/worker/types';

export interface IWorkerHub {
  wesh: IWeshWorker,
  globalSearch: IGlobalSearchWorker,
  fileExplorer: IFileExplorerWorker,
  advancedTextEditorV3: IAdvancedTextEditorV3Worker,
  highlight: IHighlightWorker,
}

export interface StandaloneWorkerHubClient {
  remote: Comlink.Remote<IWorkerHub>,
  worker: Worker,
}
