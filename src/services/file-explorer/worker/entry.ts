import * as Comlink from 'comlink'
import { createFileExplorerWorker } from './impl'

Comlink.expose(createFileExplorerWorker({}))
