import * as Comlink from 'comlink'
import { createAdvancedTextEditorV3Worker } from './advanced-text-editor-v3.worker.impl'

Comlink.expose(createAdvancedTextEditorV3Worker({}))
