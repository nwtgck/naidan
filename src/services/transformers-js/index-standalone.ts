import type { ChatMessage, LmParameters } from '@/models/types';
import type { ProgressInfo, WorkerToolDefinition, TransformersJsChunkCallback, TransformersJsToolCallsCallback } from './types';

type ProgressListener = ({
  status,
  progress,
  error,
  isCached,
  isLoadingFromCache,
  progressItems,
  loadingModelId,
}: {
  status: 'idle' | 'loading' | 'ready' | 'error';
  progress: number;
  error?: string;
  isCached?: boolean;
  isLoadingFromCache?: boolean;
  progressItems?: Record<string, ProgressInfo>;
  loadingModelId?: string;
}) => void;

type ModelListListener = () => void;

const unsupportedError = () => new Error('Transformers.js is not available in standalone mode');

const progressItems: Record<string, ProgressInfo> = {};

export const transformersJsService = {
  subscribe({ listener }: { listener: ProgressListener }) {
    listener({ status: 'idle', progress: 0, error: undefined, isCached: false, isLoadingFromCache: false, progressItems, loadingModelId: undefined });
    return () => {};
  },

  subscribeModelList({ listener: _listener }: { listener: ModelListListener }) {
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

  async importFile({ modelName: _modelName, fileName: _fileName, data: _data }: {
    modelName: string;
    fileName: string;
    data: ArrayBuffer | ReadableStream;
  }) {
    throw unsupportedError();
  },

  async deleteModel({ modelId: _modelId }: { modelId: string }) {
    throw unsupportedError();
  },

  async loadModel({ modelId: _modelId }: { modelId: string }) {
    throw unsupportedError();
  },

  async downloadModel({ modelId: _modelId }: { modelId: string }) {
    throw unsupportedError();
  },

  async unloadModel() {},

  async interrupt() {},

  async resetCache() {},

  async generateText({ messages: _messages, onChunk: _onChunk, onToolCalls: _onToolCalls, params: _params, tools: _tools, signal: _signal }: {
    messages: ChatMessage[];
    onChunk: TransformersJsChunkCallback;
    onToolCalls: TransformersJsToolCallsCallback;
    params?: LmParameters;
    tools?: WorkerToolDefinition[];
    signal?: AbortSignal;
  }) {
    throw unsupportedError();
  },
};
