import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import type { LlamaCppBrowserService } from './service-contract';
import { LlamaCppBrowserProvider } from './provider-hosted';
const service = vi.hoisted(() => ({ generate: vi.fn<LlamaCppBrowserService['generate']>(), listModels: vi.fn<LlamaCppBrowserService['listModels']>() }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
beforeEach(() => {
  vi.clearAllMocks(); service.generate.mockResolvedValue();
});
function request(): Parameters<LmProvider['chat']>[0] {
  return { messages: [{ role: 'user', content: 'hello' }], model: 'local.gguf', onChunk: vi.fn(), onAssistantMessageStart: vi.fn() };
}
describe('text-only local model provider', () => {
  it('maps model identity and text messages without normalizing away content', async () => {
    service.listModels.mockResolvedValue([{ id: 'user/local-GGUF/local.gguf', name: 'local.gguf', size: 100, importedAt: 1 }]);
    const provider = new LlamaCppBrowserProvider();
    expect(await provider.listModels({})).toEqual(['local.gguf']);
    const input = request(); input.messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'second' }] }];
    await provider.chat(input);
    expect(input.onAssistantMessageStart).toHaveBeenCalledOnce();
    expect(service.generate).toHaveBeenCalledOnce();
    expect(service.generate.mock.calls[0]?.[0].input.messages).toEqual([{ role: 'system', content: 'rules' }, { role: 'user', content: 'first second' }]);
    expect(service.generate.mock.calls[0]?.[0].input.model).toBe('local.gguf');
    expect(service.generate.mock.calls[0]?.[0].onChunk).toBe(input.onChunk);
  });
  it('rejects images instead of silently dropping an attachment', async () => {
    const input = request(); input.messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,private' } }] }];
    await expect(new LlamaCppBrowserProvider().chat(input)).rejects.toThrow('unsupported-input');
    expect(input.onAssistantMessageStart).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
  });
  it('does not turn tool-role messages into ordinary assistant text', async () => {
    const input = request(); input.messages = [{ role: 'tool', content: 'private tool result' }];
    await expect(new LlamaCppBrowserProvider().chat(input)).rejects.toThrow('unsupported-input');
    expect(input.onAssistantMessageStart).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
  });
  it('does not start generation for an already aborted request', async () => {
    const input = request(); input.signal = AbortSignal.abort();
    await expect(new LlamaCppBrowserProvider().chat(input)).rejects.toThrow('aborted');
    expect(input.onAssistantMessageStart).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
  });
});
