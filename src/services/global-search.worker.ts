import * as Comlink from 'comlink'
import { createGlobalSearchWorker } from './global-search.worker.impl'

Comlink.expose(createGlobalSearchWorker({}))
