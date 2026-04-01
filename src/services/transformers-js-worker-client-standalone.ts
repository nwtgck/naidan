import type { EmptyArgs, ChatMessage, LmParameters, ToolCall } from '@/models/types'
import type {
  TransformersJsWorkerClient,
  ProgressInfo,
  ModelLoadResult,
  WorkerToolDefinition,
} from './transformers-js.types'

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode')
}

export function createTransformersJsWorkerClient(_args: EmptyArgs): TransformersJsWorkerClient {
  return {
    async downloadModel(_args: { modelId: string, progressCallback: (x: ProgressInfo) => void }): Promise<void> {
      throw createUnsupportedError()
    },
    async prefetchUrls(_args: { urls: string[], progressCallback: (x: ProgressInfo) => void }): Promise<void> {
      throw createUnsupportedError()
    },
    async loadModel(_args: {
      modelId: string
      progressCallback: (x: ProgressInfo) => void
    }): Promise<ModelLoadResult> {
      throw createUnsupportedError()
    },
    async unloadModel(_args: EmptyArgs): Promise<void> {
      throw createUnsupportedError()
    },
    async interrupt(_args: EmptyArgs): Promise<void> {
      throw createUnsupportedError()
    },
    async resetCache(_args: EmptyArgs): Promise<void> {
      throw createUnsupportedError()
    },
    async generateText(_args: {
      messages: ChatMessage[]
      onChunk: (chunk: string) => void
      onToolCalls: (toolCalls: ToolCall[]) => void
      params?: LmParameters
      tools?: WorkerToolDefinition[]
    }): Promise<void> {
      throw createUnsupportedError()
    },
    async dispose(_args: EmptyArgs): Promise<void> {
    },
  }
}
