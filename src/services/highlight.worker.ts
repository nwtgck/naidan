import * as Comlink from 'comlink'
import { createHighlightWorker } from './highlight.worker.impl'

Comlink.expose(createHighlightWorker({}))
