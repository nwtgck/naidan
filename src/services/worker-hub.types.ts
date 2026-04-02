import type { IAdvancedTextEditorV3Worker } from './advanced-text-editor-v3.worker.types'
import type * as Comlink from 'comlink'
import type { IFileExplorerWorker } from './file-explorer.worker.types'
import type { IGlobalSearchWorker } from './global-search.worker.types'
import type { IHighlightWorker } from './highlight.worker.types'
import type { IWeshWorker } from './wesh-worker.types'

export interface IWorkerHub {
  wesh: IWeshWorker
  globalSearch: IGlobalSearchWorker
  fileExplorer: IFileExplorerWorker
  advancedTextEditorV3: IAdvancedTextEditorV3Worker
  highlight: IHighlightWorker
}

export interface StandaloneWorkerHubClient {
  remote: Comlink.Remote<IWorkerHub>
  worker: Worker
}
