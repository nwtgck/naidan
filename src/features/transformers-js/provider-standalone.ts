import type { ChatMessage, LmParameters } from '@/01-models/types';
import type { BinaryObjectId } from '@/01-models/ids';
import type { ChatGenerationItem, JsonValue, LmProvider } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode');
}

export class TransformersJsProvider implements LmProvider {
  chat({ messages: _messages, model: _model, parameters: _parameters, tools: _tools, readBinaryObject: _readBinaryObject, signal }: {
    messages: readonly ChatMessage[],
    model: string,
    parameters: LmParameters | undefined,
    tools: readonly { name: string, description: string, parameters: { [keyword: string]: JsonValue } }[] | undefined,
    readBinaryObject: (({ binaryObjectId, signal }: { binaryObjectId: BinaryObjectId, signal: AbortSignal | undefined }) => Promise<Blob>) | undefined,
    signal: AbortSignal | undefined,
  }): AsyncIterable<ChatGenerationItem> {
    // Use the same local contract without importing or starting the hosted runtime.
    return createChatGenerationStream({ signal, run: async () => {
      throw createUnsupportedError();
    } });
  }

  async listModels({ signal: _signal }: { signal: AbortSignal | undefined }): Promise<string[]> {
    return [];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
