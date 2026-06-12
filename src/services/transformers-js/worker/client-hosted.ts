import * as Comlink from 'comlink'
import type { EmptyArgs, ChatMessage, LmParameters, ToolCall } from '@/models/types'
import type {
  ITransformersJsWorker,
  TransformersJsWorkerClient,
  WorkerToolDefinition,
  ProgressInfo,
  ModelLoadResult,
  TransformersJsProgressCallback,
  TransformersJsChunkCallback,
  TransformersJsToolCallsCallback,
} from '@/services/transformers-js/types'

function createUnavailableEnvironmentError(): Error {
  return new Error('Transformers.js worker is not available in this environment')
}

export function createTransformersJsWorkerClient(_args: EmptyArgs): TransformersJsWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async downloadModel({ modelId: _modelId, progressCallback: _progressCallback }) {
        throw createUnavailableEnvironmentError()
      },
      async prefetchUrls({ urls: _urls, progressCallback: _progressCallback }) {
        throw createUnavailableEnvironmentError()
      },
      async loadModel({ modelId: _modelId, progressCallback: _progressCallback }) {
        throw createUnavailableEnvironmentError()
      },
      async unloadModel(_args: EmptyArgs) {
        throw createUnavailableEnvironmentError()
      },
      async interrupt(_args: EmptyArgs) {
        throw createUnavailableEnvironmentError()
      },
      async resetCache(_args: EmptyArgs) {
        throw createUnavailableEnvironmentError()
      },
      async generateText({ messages: _messages, onChunk: _onChunk, onToolCalls: _onToolCalls, params: _params, tools: _tools }) {
        throw createUnavailableEnvironmentError()
      },
      async dispose(_args: EmptyArgs) {
      },
    }
  }

  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    { type: 'module' }
  )

  const remote = Comlink.wrap<ITransformersJsWorker>(worker)

  return {
    async downloadModel({ modelId, progressCallback }: {
      modelId: string
      progressCallback: TransformersJsProgressCallback
    }): Promise<void> {
      return remote.downloadModel(modelId, Comlink.proxy((info: ProgressInfo) => progressCallback({ info })))
    },
    async prefetchUrls({ urls, progressCallback }: {
      urls: string[]
      progressCallback: TransformersJsProgressCallback
    }): Promise<void> {
      return remote.prefetchUrls(urls, Comlink.proxy((info: ProgressInfo) => progressCallback({ info })))
    },
    async loadModel({ modelId, progressCallback }: {
      modelId: string
      progressCallback: TransformersJsProgressCallback
    }): Promise<ModelLoadResult> {
      return remote.loadModel(modelId, Comlink.proxy((info: ProgressInfo) => progressCallback({ info })))
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
      onChunk: TransformersJsChunkCallback
      onToolCalls: TransformersJsToolCallsCallback
      params?: LmParameters
      tools?: WorkerToolDefinition[]
    }): Promise<void> {
      return remote.generateText(
        messages,
        Comlink.proxy((chunk: string) => onChunk({ chunk })),
        Comlink.proxy((toolCalls: ToolCall[]) => onToolCalls({ toolCalls })),
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
