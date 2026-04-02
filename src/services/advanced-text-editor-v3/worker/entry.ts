import * as Comlink from 'comlink'
import { createAdvancedTextEditorV3Worker } from './impl'

Comlink.expose(createAdvancedTextEditorV3Worker({}))
