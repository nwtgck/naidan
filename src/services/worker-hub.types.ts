import type * as Comlink from 'comlink'
import type { IFileExplorerWorker } from './file-explorer.worker.types'
import type { IGlobalSearchWorker } from './global-search.worker.types'
import type { IWeshWorker } from './wesh-worker.types'

export interface IWorkerHub {
  wesh: IWeshWorker
  globalSearch: IGlobalSearchWorker
  fileExplorer: IFileExplorerWorker
}

export interface StandaloneWorkerHubClient {
  remote: Comlink.Remote<IWorkerHub>
  worker: Worker
}
