import * as Comlink from 'comlink'
import { createWeshWorker } from './wesh.worker.impl'

Comlink.expose(createWeshWorker({}))
