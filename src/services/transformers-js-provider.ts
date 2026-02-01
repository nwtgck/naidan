import type { LLMProvider } from './llm';
import type { ChatMessage, LmParameters } from '../models/types';
import { transformersJsService } from './transformers-js';

export class TransformersJsProvider implements LLMProvider {
  async chat(params: {
    messages: ChatMessage[];
    model: string;
    onChunk: (chunk: string) => void;
    parameters?: LmParameters;
    signal?: AbortSignal;
  }): Promise<void> {
    const { messages, model, onChunk, parameters, signal } = params;
    
    // Auto-load if needed
    const state = transformersJsService.getState();
    if (state.activeModelId !== model || state.status !== 'ready') {
      const status = state.status;
      switch (status) {
      case 'loading':
        // Wait for the existing loading process to finish if it's the same model,
        // otherwise throw or wait for it to fail. For now, keep it simple.
        throw new Error('Engine is busy. Please wait for the current operation to finish.');
      case 'idle':
      case 'ready':
      case 'error':
        break;
      default: {
        const _ex: never = status;
        throw new Error(`Unhandled status: ${_ex}`);
      }
      }
      
      console.log(`[TransformersJsProvider] Auto-loading model: ${model}`);
      await transformersJsService.loadModel(model);
    }

    await transformersJsService.generateText(messages, onChunk, parameters, signal);
  }

  async listModels(_params: { signal?: AbortSignal }): Promise<string[]> {
    try {
      const models = await transformersJsService.listCachedModels();
      return models.map(m => m.id);
    } catch (err) {
      console.warn('Failed to list local models for provider:', err);
      return [];
    }
  }
}