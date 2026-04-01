import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createFileExplorerWorker } from './file-explorer.worker.impl'
import type { IWorkerHub } from './worker-hub.types'
import { createGlobalSearchWorker } from './global-search.worker.impl'
import { createWeshWorker } from './wesh.worker.impl'

export function createStandaloneWorkerHub(_args: EmptyArgs): IWorkerHub {
  return {
    wesh: Comlink.proxy(createWeshWorker({})),
    globalSearch: Comlink.proxy(createGlobalSearchWorker({})),
    fileExplorer: Comlink.proxy(createFileExplorerWorker({})),
  }
}
