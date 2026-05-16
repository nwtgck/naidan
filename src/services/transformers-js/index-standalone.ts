import type { ChatMessage, LmParameters, ToolCall } from '@/models/types';
import type { ProgressInfo, WorkerToolDefinition } from './types';

type ProgressListener = (
  status: 'idle' | 'loading' | 'ready' | 'error',
  progress: number,
  error?: string,
  isCached?: boolean,
  isLoadingFromCache?: boolean,
  progressItems?: Record<string, ProgressInfo>,
  loadingModelId?: string
) => void;

type ModelListListener = () => void;

const unsupportedError = () => new Error('Transformers.js is not available in standalone mode');

const progressItems: Record<string, ProgressInfo> = {};

export const transformersJsService = {
  subscribe(listener: ProgressListener) {
    listener('idle', 0, undefined, false, false, progressItems, undefined);
    return () => {};
  },

  subscribeModelList(_listener: ModelListListener) {
    return () => {};
  },

  getState() {
    return {
      status: 'idle' as const,
      progress: 0,
      error: undefined,
      activeModelId: undefined,
      loadingModelId: undefined,
      device: 'wasm',
      isCached: false,
      isLoadingFromCache: false,
      progressItems,
      totalLoadedAmount: 0,
      totalSizeAmount: 0,
    };
  },

  async restart() {},

  async listCachedModels(): Promise<Array<{ id: string; isLocal: boolean; size: number; fileCount: number; lastModified: number; isComplete: boolean }>> {
    return [];
  },

  async importFile(_modelName: string, _fileName: string, _data: ArrayBuffer | ReadableStream) {
    throw unsupportedError();
  },

  async deleteModel(_modelId: string) {
    throw unsupportedError();
  },

  async loadModel(_modelId: string) {
    throw unsupportedError();
  },

  async downloadModel(_modelId: string) {
    throw unsupportedError();
  },

  async unloadModel() {},

  async interrupt() {},

  async resetCache() {},

  async generateText(
    _messages: ChatMessage[],
    _onChunk: (chunk: string) => void,
    _onToolCalls: (toolCalls: ToolCall[]) => void,
    _params?: LmParameters,
    _tools?: WorkerToolDefinition[],
    _signal?: AbortSignal
  ) {
    throw unsupportedError();
  },
};
