import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createAdvancedTextEditorV3Worker } from './impl'
import {
  advancedTextEditorV3ApplyMultiEditResponseSchema,
  advancedTextEditorV3PrepareMultiEditResponseSchema,
  advancedTextEditorV3ReplaceAllResponseSchema,
  advancedTextEditorV3ReplaceSingleResponseSchema,
  advancedTextEditorV3SearchTextResponseSchema,
  type AdvancedTextEditorV3WorkerClient,
  type IAdvancedTextEditorV3Worker,
} from './types'

function createMainThreadFallbackClient(_args: EmptyArgs): AdvancedTextEditorV3WorkerClient {
  const worker = createAdvancedTextEditorV3Worker({})
  return {
    async searchText({ request }) {
      return advancedTextEditorV3SearchTextResponseSchema.parse(await worker.searchText({ request }))
    },
    async replaceAll({ request }) {
      return advancedTextEditorV3ReplaceAllResponseSchema.parse(await worker.replaceAll({ request }))
    },
    async replaceSingle({ request }) {
      return advancedTextEditorV3ReplaceSingleResponseSchema.parse(await worker.replaceSingle({ request }))
    },
    async prepareMultiEdit({ request }) {
      return advancedTextEditorV3PrepareMultiEditResponseSchema.parse(await worker.prepareMultiEdit({ request }))
    },
    async applyMultiEdit({ request }) {
      return advancedTextEditorV3ApplyMultiEditResponseSchema.parse(await worker.applyMultiEdit({ request }))
    },
    async dispose(_args: EmptyArgs) {
    },
  }
}

export async function createAdvancedTextEditorV3WorkerClient(_args: EmptyArgs): Promise<AdvancedTextEditorV3WorkerClient> {
  if (typeof Worker === 'undefined') {
    return createMainThreadFallbackClient({})
  }

  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    {
      type: 'module',
      name: 'naidan-advanced-text-editor-v3-worker',
    },
  )
  const remote = Comlink.wrap<IAdvancedTextEditorV3Worker>(worker)

  return {
    async searchText({ request }) {
      return advancedTextEditorV3SearchTextResponseSchema.parse(await remote.searchText({ request }))
    },
    async replaceAll({ request }) {
      return advancedTextEditorV3ReplaceAllResponseSchema.parse(await remote.replaceAll({ request }))
    },
    async replaceSingle({ request }) {
      return advancedTextEditorV3ReplaceSingleResponseSchema.parse(await remote.replaceSingle({ request }))
    },
    async prepareMultiEdit({ request }) {
      return advancedTextEditorV3PrepareMultiEditResponseSchema.parse(await remote.prepareMultiEdit({ request }))
    },
    async applyMultiEdit({ request }) {
      return advancedTextEditorV3ApplyMultiEditResponseSchema.parse(await remote.applyMultiEdit({ request }))
    },
    async dispose(_args: EmptyArgs) {
      try {
        await remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}
