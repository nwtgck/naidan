import * as Comlink from 'comlink'
import { createGlobalSearchWorker } from './impl'

Comlink.expose(createGlobalSearchWorker())
