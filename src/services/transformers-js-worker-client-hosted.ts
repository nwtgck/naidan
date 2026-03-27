import * as Comlink from 'comlink'
import type { EmptyArgs, ChatMessage, LmParameters, ToolCall } from '@/models/types'
import type {
  ITransformersJsWorker,
  TransformersJsWorkerClient,
  WorkerToolDefinition,
  ProgressInfo,
  ModelLoadResult,
} from './transformers-js.types'

function createUnavailableEnvironmentError(): Error {
  return new Error('Transformers.js worker is not available in this environment')
}

export function createTransformersJsWorkerClient(_args: EmptyArgs): TransformersJsWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async downloadModel(_args) {
        throw createUnavailableEnvironmentError()
      },
      async prefetchUrls(_args) {
        throw createUnavailableEnvironmentError()
      },
      async loadModel(_args) {
        throw createUnavailableEnvironmentError()
      },
      async unloadModel(_args) {
        throw createUnavailableEnvironmentError()
      },
      async interrupt(_args) {
        throw createUnavailableEnvironmentError()
      },
      async resetCache(_args) {
        throw createUnavailableEnvironmentError()
      },
      async generateText(_args) {
        throw createUnavailableEnvironmentError()
      },
      async dispose(_args) {
      },
    }
  }

  const worker = new Worker(
    new URL('./transformers-js.worker.ts', import.meta.url),
    { type: 'module' }
  )

  const remote = Comlink.wrap<ITransformersJsWorker>(worker)

  return {
    async downloadModel({ modelId, progressCallback }: {
      modelId: string
      progressCallback: (x: ProgressInfo) => void
    }): Promise<void> {
      return remote.downloadModel(modelId, Comlink.proxy(progressCallback))
    },
    async prefetchUrls({ urls, progressCallback }: {
      urls: string[]
      progressCallback: (x: ProgressInfo) => void
    }): Promise<void> {
      return remote.prefetchUrls(urls, Comlink.proxy(progressCallback))
    },
    async loadModel({ modelId, progressCallback }: {
      modelId: string
      progressCallback: (x: ProgressInfo) => void
    }): Promise<ModelLoadResult> {
      return remote.loadModel(modelId, Comlink.proxy(progressCallback))
    },
    async unloadModel(_args: EmptyArgs): Promise<void> {
      return remote.unloadModel()
    },
    async interrupt(_args: EmptyArgs): Promise<void> {
      return remote.interrupt()
    },
    async resetCache(_args: EmptyArgs): Promise<void> {
      return remote.resetCache()
    },
    async generateText({ messages, onChunk, onToolCalls, params, tools }: {
      messages: ChatMessage[]
      onChunk: (chunk: string) => void
      onToolCalls: (toolCalls: ToolCall[]) => void
      params?: LmParameters
      tools?: WorkerToolDefinition[]
    }): Promise<void> {
      return remote.generateText(
        messages,
        Comlink.proxy(onChunk),
        Comlink.proxy(onToolCalls),
        params,
        tools
      )
    },
    async dispose(_args: EmptyArgs): Promise<void> {
      try {
        await remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}
