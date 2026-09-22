import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectChatGeneration } from '@/logic/collect-chat-generation';
import { LlamaCppBrowserProvider } from './provider-standalone';
import { chatRequest, deliverNativeResult, finalText } from './test-utils/chat';
import type { LlamaCppBrowserService } from './service-contract';
import { ensureAllStringsForTest } from '@/strings/test-utils';

const service = vi.hoisted(() => ({ generate: vi.fn<LlamaCppBrowserService['generate']>(), listModels: vi.fn<LlamaCppBrowserService['listModels']>(), runGenerationOperation: vi.fn<LlamaCppBrowserService['runGenerationOperation']>() }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
beforeEach(async () => {
  vi.clearAllMocks(); await ensureAllStringsForTest({ locale: 'en' });
  service.listModels.mockResolvedValue([]);
  service.generate.mockImplementation(async ({ onEvent }) => deliverNativeResult({ result: finalText({ text: 'answer' }), onEvent }));
});

describe('standalone llama.cpp generation facade', () => {
  it('uses the shared generation contract while leaving runtime loading to the selected service', async () => {
    const provider = new LlamaCppBrowserProvider();const readBinaryObject = vi.fn();const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await provider.listModels({ signal: undefined })).toEqual([]);
      const { text, result } = await collectChatGeneration({ items: provider.chat({ ...chatRequest(), readBinaryObject }), abortController: new AbortController() });
      expect(text).toBe('answer');expect(result).toEqual({ type: 'finished', next: 'user' });
      expect(service.generate).toHaveBeenCalledOnce();expect(readBinaryObject).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it('represents pre-cancellation as interruption without starting generation', async () => {
    const { result, text } = await collectChatGeneration({ items: new LlamaCppBrowserProvider().chat({ ...chatRequest(), signal: AbortSignal.abort() }), abortController: new AbortController() });
    expect(text).toBe('');expect(result).toEqual({ type: 'interrupted', reason: 'aborted' });
    expect(service.generate).not.toHaveBeenCalled();
  });
});
