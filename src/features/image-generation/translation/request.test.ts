import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGenerationResult, LmProvider } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { imagePromptTranslationMessages, translateImagePrompt } from './request';
const mocks = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: mocks.provider }));
const args = () => ({
  prompt: `\
  a cat 🐈
(weight:1.2)  `,
  language: 'ja' as const,
  endpoint: { type: 'ollama' as const, url: 'http://localhost:11434', httpHeaders: undefined },
  modelId: 'translator',
  parameters: undefined,
  signal: new AbortController().signal,
  fakeLmDebugModeStatus: 'disabled' as const,
});
function providerWith({ result, output }: { result: ChatGenerationResult, output: string }) {
  const chat = vi.fn<LmProvider['chat']>(({ signal }) => createChatGenerationStream({
    signal,
    run: async ({ writer }) => {
      await writer.text({ type: 'reasoning', text: 'not part of the translation' });
      await writer.text({ type: 'text', text: output }); return result;
    },
  }));
  const provider: LmProvider = { chat, listModels: vi.fn(async () => []) };
  mocks.provider.mockResolvedValue(provider);
  return { provider, chat };
}
beforeEach(() => {
  vi.resetAllMocks();
});
describe('transient read-only prompt translation', () => {
  it('uses an English system instruction and the original text verbatim in a user message', async () => {
    const value = args(), { chat } = providerWith({
      output: `\
  猫 🐈
(weight:1.2)  `,
      result: { type: 'finished', next: 'user' },
    });
    expect(await translateImagePrompt(value)).toBe(`\
  猫 🐈
(weight:1.2)  `);
    const request = chat.mock.calls[0]![0];
    expect(request.messages).toEqual(imagePromptTranslationMessages({ prompt: value.prompt, language: 'ja' }));
    expect(request.messages[0]!.parts).toEqual([expect.objectContaining({ text: expect.stringContaining('Japanese') })]);
    expect(request.messages[1]!.parts).toEqual([{ type: 'text', text: value.prompt, completeness: 'complete' }]);
    expect(request.model).toBe('translator'); expect(request.tools).toBeUndefined(); expect(request.readBinaryObject).toBeUndefined();
    expect(value.prompt).toBe(`\
  a cat 🐈
(weight:1.2)  `);
  });
  it('uses the provider runtime operation instead of bypassing shared local-model ownership', async () => {
    const { provider, chat } = providerWith({ output: '訳', result: { type: 'finished', next: 'user' } });
    const operation = vi.fn<NonNullable<LmProvider['runChatOperation']>>(async ({ operation, signal }) => {
      await operation({ chat: provider.chat.bind(provider), signal: signal ?? new AbortController().signal });
    });
    provider.runChatOperation = operation;
    expect(await translateImagePrompt(args())).toBe('訳'); expect(operation).toHaveBeenCalledTimes(1); expect(chat).toHaveBeenCalledTimes(1);
  });
  it.each([
    { type: 'interrupted', reason: 'limit' }, { type: 'finished', next: 'tool_results' }, { type: 'error', error: new Error('offline') },
  ] satisfies ChatGenerationResult[])('does not claim partial or tool-requested output as a completed translation: $type', async result => {
    providerWith({ output: 'partial', result }); await expect(translateImagePrompt(args())).rejects.toThrow();
  });
  it('reports an empty response', async () => {
    providerWith({ output: ' ', result: { type: 'finished', next: 'user' } }); await expect(translateImagePrompt(args())).rejects.toThrow('no translation');
  });
  it('validates inputs before loading a provider and never creates a fallback request', async () => {
    await expect(translateImagePrompt({ ...args(), modelId: undefined })).rejects.toThrow('model');
    await expect(translateImagePrompt({ ...args(), prompt: '  ' })).rejects.toThrow('empty');
    await expect(translateImagePrompt({ ...args(), endpoint: { type: 'openai', url: '', httpHeaders: undefined } })).rejects.toThrow('endpoint');
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it('does not start chat after cancellation during provider loading', async () => {
    const { provider, chat } = providerWith({ output: 'late', result: { type: 'finished', next: 'user' } });
    const pending = Promise.withResolvers<LmProvider>(); mocks.provider.mockReturnValue(pending.promise);
    const abort = new AbortController(); const operation = translateImagePrompt({ ...args(), signal: abort.signal });
    abort.abort(); pending.resolve(provider);
    await expect(operation).rejects.toThrow(); expect(chat).not.toHaveBeenCalled();
  });
  it('honors an operation-level abort even if its outer signal is not aborted', async () => {
    const { provider, chat } = providerWith({ output: 'unused', result: { type: 'finished', next: 'user' } });
    provider.runChatOperation = async ({ operation }) => {
      const abort = new AbortController(); abort.abort(); await operation({ chat: provider.chat.bind(provider), signal: abort.signal });
    };
    await expect(translateImagePrompt(args())).rejects.toThrow(); expect(chat).not.toHaveBeenCalled();
  });
  it('rejects a provider that does not enter its runtime operation', async () => {
    const { provider } = providerWith({ output: 'unused', result: { type: 'finished', next: 'user' } });
    provider.runChatOperation = async () => {};
    await expect(translateImagePrompt(args())).rejects.toThrow('did not run');
  });
});

it.each([
  { type: 'interrupted', reason: 'limit' },
] satisfies ChatGenerationResult[])('rejects translation semantics only after the healthy runtime scope closes: $type', async result => {
  const { provider } = providerWith({ output: 'partial', result });
  let operationFailed = false, closed = false;
  provider.runChatOperation = async ({ operation, signal }) => {
    try {
      await operation({ chat: provider.chat, signal: signal ?? new AbortController().signal });
    } catch (error) {
      operationFailed = true; throw error;
    } finally {
      closed = true;
    }
  };
  await expect(translateImagePrompt(args())).rejects.toThrow();
  expect(closed).toBe(true); expect(operationFailed).toBe(false);
});
it('keeps empty successful native output separate from a runtime failure', async () => {
  const { provider } = providerWith({ output: '', result: { type: 'finished', next: 'user' } });
  const scope = vi.fn<NonNullable<LmProvider['runChatOperation']>>(async ({ operation, signal }) => {
    await expect(operation({ chat: provider.chat, signal: signal ?? new AbortController().signal })).resolves.toBeUndefined();
  });
  provider.runChatOperation = scope;
  await expect(translateImagePrompt(args())).rejects.toThrow('no translation');
  expect(scope).toHaveBeenCalledTimes(1);
});
it('streams escaped text without reasoning and isolates a failing display observer', async () => {
  providerWith({ output: '<cat>', result: { type: 'finished', next: 'user' } });
  const text: string[] = [];
  expect(await translateImagePrompt({
    ...args(),
    onText({ text: value }) {
      text.push(value); throw new Error('renderer failed');
    },
  })).toBe('<cat>');
  expect(text).toContain('<cat>'); expect(text.join('')).not.toContain('not part of the translation');
});
it('still propagates native errors inside the owned runtime operation', async () => {
  const error = new Error('native failure');
  const { provider } = providerWith({ output: '', result: { type: 'error', error } });
  let caught: unknown;
  provider.runChatOperation = async ({ operation, signal }) => {
    try {
      await operation({ chat: provider.chat, signal: signal ?? new AbortController().signal });
    } catch (failure) {
      caught = failure; throw failure;
    }
  };
  await expect(translateImagePrompt(args())).rejects.toBe(error);
  expect(caught).toBe(error);
});
