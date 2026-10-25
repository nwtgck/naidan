import { vi } from 'vitest';
import type { AssistantMessageNode } from '@/01-models/types';
import type { GenerationMetricsObserver } from '@/01-models/generation-metrics';
import { toMessageId } from '@/01-models/ids';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import type { LmFetch } from './fetch';

export function createMetricsStreamForTest({ protocol = 'sse', observer }: { protocol?: 'sse' | 'ndjson', observer?: GenerationMetricsObserver } = {}) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const canceled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
    cancel(reason) {
      closed = true;
      canceled(reason);
    },
  });
  const fetcher = vi.fn<LmFetch>(async () => new Response(stream));
  const provider = (() => {
    switch (protocol) {
    case 'sse': return new OpenAIProvider({ endpoint: 'https://example.invalid/v1', fetcher });
    case 'ndjson': return new OllamaProvider({ endpoint: 'https://example.invalid', fetcher });
    default: {
      const exhaustive: never = protocol;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const controller = new AbortController();
  const message: AssistantMessageNode = { id: toMessageId({ raw: 'metrics' }), role: 'assistant', parts: [], createdAt: 1, modelId: 'fixture', lmParameters: undefined, interruption: undefined, replies: { items: [] } };
  const result = consumeChatGeneration({ node: message, onToolCallDraftsChange: undefined, abortController: controller, onChange: () => {}, items: provider.chat({ messages: [], model: 'fixture', parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: controller.signal, onGenerationMetrics: observer }) });
  return {
    controller,
    result,
    message,
    fetcher,
    canceled,
    send({ value }: { value: unknown }): void {
      if (closed) {
        throw new Error('Test stream is already closed');
      }
      const json = JSON.stringify(value);
      switch (protocol) {
      case 'sse': source.enqueue(new TextEncoder().encode(`data: ${json}\n\n`));
        break;
      case 'ndjson': source.enqueue(new TextEncoder().encode(`${json}\n`));
        break;
      default: {
        const exhaustive: never = protocol;
        throw new Error(String(exhaustive));
      }
      }
    },
    sendRaw({ text }: { text: string }): void {
      source.enqueue(new TextEncoder().encode(text));
    },
    close(): void {
      if (!closed) {
        closed = true;
        source.close();
      }
    },
    [Symbol.dispose](): void {
      controller.abort();
      if (!closed) {
        closed = true;
        source.close();
      }
    },
  };
}

export function useMetricsFakeTimersForTest() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return {
    [Symbol.dispose](): void {
      vi.useRealTimers();
    },
  };
}
