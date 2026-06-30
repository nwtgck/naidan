import { createEmptyFakeLmInputAnalysis } from '@/features/fake-lm/core/inputAnalysis';
import { streamFakeLmMarkdown, type StreamFakeLmMarkdownInput } from '@/features/fake-lm/core/stream';

export async function generateFakeLmMarkdown({ language, mode, seed, thinkingEffort, inputAnalysis, signal }: Omit<StreamFakeLmMarkdownInput, 'chunking' | 'inputAnalysis'> & { inputAnalysis?: StreamFakeLmMarkdownInput['inputAnalysis'] }): Promise<string> {
  let markdown = '';

  for await (const item of streamFakeLmMarkdown({
    language,
    mode,
    seed,
    thinkingEffort,
    inputAnalysis: inputAnalysis ?? createEmptyFakeLmInputAnalysis(),
    signal,
    chunking: {
      minChars: 1024,
      maxChars: 1024,
      delayMs: 0,
    },
  })) {
    switch (item.type) {
    case 'content':
      markdown += item.chunk;
      break;
    case 'thinking':
      break;
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled fake LM stream item: ${String(((_ex satisfies never) as { readonly type: string }).type)}`);
    }
    }
  }

  return markdown.trimEnd();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
