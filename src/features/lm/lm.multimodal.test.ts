import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '@/features/lm/openai';
import { OllamaProvider } from '@/features/lm/ollama';
import { toMessageId, toAttachmentId, toBinaryObjectId } from '@/01-models/ids';
import type { ChatMessage } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import type { LmFetch } from './fetch';
import { consumeProviderGenerationForTest } from './provider-test-support';

function request({ text, model }: { text: string, model: string }): Parameters<LmProvider['chat']>[0] {
  const messages: ChatMessage[] = [{
    id: toMessageId({ raw: 'u' }), role: 'user', parts: [
      { id: 'text', type: 'text', text, completeness: 'complete' },
      { id: 'image', type: 'attachment', attachment: {
        id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }),
        originalName: 'image.png', mimeType: 'image/png', size: 3, uploadedAt: 1,
        status: 'memory', blob: new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }),
      } },
    ],
  }];
  return { debug: undefined, messages, model, parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined };
}
function body({ fetcher }: { fetcher: ReturnType<typeof vi.fn<LmFetch>> }) {
  const raw = fetcher.mock.calls[0]?.[1]?.body;
  if (typeof raw !== 'string') throw new Error('Expected a serialized request.');
  return JSON.parse(raw);
}

describe('LM Providers - Multimodal Requests', () => {
  it('OpenAIProvider should format multimodal messages correctly', async () => {
    const fetcher = vi.fn<LmFetch>().mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    const provider = new OpenAIProvider({ endpoint: 'http://test.api', fetcher });
    const { result } = await consumeProviderGenerationForTest({ provider, request: request({ text: 'Analyze this:', model: 'gpt-4-vision' }) });
    expect(body({ fetcher }).messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'Analyze this:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ] }]);
    expect(result).toEqual({ type: 'finished', next: 'user' });
  });

  it('OllamaProvider should handle multimodal messages as text plus images', async () => {
    const fetcher = vi.fn<LmFetch>().mockResolvedValueOnce(new Response('{"done":true}\n'));
    const provider = new OllamaProvider({ endpoint: 'http://test.api', fetcher });
    const { result } = await consumeProviderGenerationForTest({ provider, request: request({ text: 'See this', model: 'llava' }) });
    expect(body({ fetcher }).messages).toEqual([{ role: 'user', content: 'See this', images: ['AQID'] }]);
    expect(result).toEqual({ type: 'finished', next: 'user' });
  });
});
