import * as Comlink from 'comlink'
import { createFileExplorerWorker } from './file-explorer.worker.impl'

Comlink.expose(createFileExplorerWorker({}))
