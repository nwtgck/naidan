import type { LmProvider } from '@/01-models/lm';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { LlamaCppBrowserError, type GenerateInput } from './types';

export class LlamaCppBrowserProvider implements LmProvider {
  async listModels({ signal }: Parameters<LmProvider['listModels']>[0]): Promise<string[]> {
    return (await llamaCppBrowserService.listModels({ signal })).map(model => model.name);
  }
  async chat({ messages, model, onChunk, parameters, tools, onAssistantMessageStart, signal }: Parameters<LmProvider['chat']>[0]): Promise<void> {
    // Do not silently discard images or tool state when exposing a text-only first version.
    if (tools && tools.length > 0) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    const accepted: GenerateInput['messages'] = messages.map(message => {
      if (message.tool_calls?.length || message.tool_call_id) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      const role = message.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      const content = typeof message.content === 'string' ? message.content : message.content.map(part => {
        switch (part.type) {
        case 'text': return part.text;
        case 'image_url': throw new LlamaCppBrowserError({ code: 'unsupported-input' });
        default: { const exhaustive: never = part; throw new Error(String(exhaustive)); }
        }
      }).join('');
      return { role, content };
    });
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    onAssistantMessageStart?.();
    await llamaCppBrowserService.generate({
      input: { model, messages: accepted, temperature: parameters?.temperature ?? 0.7,
        topP: parameters?.topP ?? 0.95, maxTokens: parameters?.maxCompletionTokens ?? 1024,
        presencePenalty: parameters?.presencePenalty ?? 0, frequencyPenalty: parameters?.frequencyPenalty ?? 0,
        stop: parameters?.stop ? [...parameters.stop] : [] }, onChunk, signal,
    });
  }
}
export const TEST_ONLY = {
};
