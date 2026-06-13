import * as Comlink from 'comlink'
import { createHighlightWorker } from './impl'

Comlink.expose(createHighlightWorker())
