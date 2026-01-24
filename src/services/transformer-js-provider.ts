import type { LLMProvider } from './llm';
import type { ChatMessage, LmParameters } from '../models/types';
import { transformerService } from './transformer-js';

export class TransformerJsProvider implements LLMProvider {
  async chat(
    messages: ChatMessage[],
    model: string,
    _endpoint: string, 
    onChunk: (chunk: string) => void,
    parameters?: LmParameters,
    _headers?: [string, string][],
    signal?: AbortSignal,
  ): Promise<void> {
    
    const state = transformerService.getState();
    if (state.activeModelId !== model || state.status !== 'ready') {
      if (state.status === 'loading') {
        throw new Error('Model is currently loading. Please wait.');
      }
      await transformerService.loadModel(model);
    }

    await transformerService.generate(messages, onChunk, parameters, signal);
  }

  async listModels(_endpoint: string, _headers?: [string, string][], _signal?: AbortSignal): Promise<string[]> {
    const defaultModels = [
      'onnx-community/Qwen2.5-0.5B-Instruct',
      'onnx-community/SmolLM2-135M-Instruct',
      'onnx-community/SmolLM2-360M-Instruct',
      'onnx-community/TinyLlama-1.1B-Chat-v1.0',
      'onnx-community/Llama-3.2-1B-Instruct',
      'onnx-community/phi-4',
      'Xenova/Qwen1.5-0.5B-Chat',
    ];
    
    try {
      const localModels = await transformerService.listLocalModels();
      return [...defaultModels, ...localModels];
    } catch (err) {
      console.warn('Failed to list local models for provider:', err);
      return defaultModels;
    }
  }
}
