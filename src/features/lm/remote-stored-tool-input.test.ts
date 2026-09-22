import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { roundTripChatContentPersistenceSerialization } from '@/00-storage/service/chat-content-serialization';
import type { LmProvider } from '@/01-models/lm';
import type { AssistantMessageNode, ChatContent, ToolMessageNode, UserMessageNode } from '@/01-models/types';
import type { TextOrBinaryObject, ToolExecutionResult } from '@/01-models/tool';
import { toBinaryObjectId, toChatId, toMessageId, toToolCallId } from '@/01-models/ids';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import type { LmFetch } from './fetch';
import { consumeProviderGenerationForTest } from './provider-test-support';

function fixture({ status, content }: { status: 'success' | 'error', content: TextOrBinaryObject }) {
  const callId = toToolCallId({ raw: 'lookup-1' });
  let result: ToolExecutionResult;
  switch (status) {
  case 'success': result = { toolCallId: callId, status, content }; break;
  case 'error': result = { toolCallId: callId, status, error: { code: 'other', message: content } }; break;
  default: { const _ex: never = status; throw new Error(`Unhandled test status: ${_ex}`); }
  }
  const tool: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 3, modelId: undefined, lmParameters: undefined,
    parts: [{ type: 'tool_result', result }], replies: { items: [] } };
  const assistant: AssistantMessageNode = { id: toMessageId({ raw: 'assistant' }), role: 'assistant', createdAt: 2, modelId: 'test', lmParameters: undefined, interruption: undefined,
    parts: [
      { type: 'reasoning', text: '  確認する。\n', completeness: 'complete' },
      { type: 'text', text: '<think>literal</think>', completeness: 'complete' },
      { type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'lookup', arguments: ' {"n": 1} ' } } },
    ], replies: { items: [tool] } };
  const user: UserMessageNode = { id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined,
    parts: [{ type: 'text', text: '質問', completeness: 'complete' }], replies: { items: [assistant] } };
  const chat: ChatContent = { root: { items: [user] }, currentLeafId: tool.id };
  return { chat, tool };
}

function providerWithRecording({ kind }: { kind: 'openai' | 'ollama' }) {
  const fetcher = vi.fn<LmFetch>().mockImplementation(async () => new Response(kind === 'openai'
    ? `\
data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}

data: [DONE]

`
    : '{"message":{"role":"assistant","content":"answer"},"done":true,"done_reason":"stop"}\n'));
  const provider: LmProvider = kind === 'openai'
    ? new OpenAIProvider({ endpoint: 'https://test.invalid', fetcher })
    : new OllamaProvider({ endpoint: 'https://test.invalid', fetcher });
  return { provider, fetcher };
}

function requestBody({ fetcher, index }: { fetcher: ReturnType<typeof vi.fn<LmFetch>>, index: number }): unknown {
  const raw = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof raw !== 'string') throw new Error('Missing serialized API request.');
  return JSON.parse(raw);
}

const contents = [
  { name: 'empty result', text: '' },
  { name: 'BOM only', text: '\uFEFF' },
  { name: 'leading BOM and verbatim Unicode', text: '\uFEFF  結果🙂e\u0301\r\n<think>literal</think>  ' },
  { name: 'multiple and interior BOMs', text: '\uFEFF\uFEFFA\uFEFFB\n' },
  { name: 'literal replacement character', text: '\uFFFD\r\n' },
];

for (const kind of ['openai', 'ollama'] as const) {
  describe(`${kind} stored tool history`, () => {
    it('keeps the selected branch API body exact across the production JSON persistence contract', async () => {
      const { provider, fetcher } = providerWithRecording({ kind });
      const storage = new MemoryStorageProvider();
      const binaryObjectId = toBinaryObjectId({ raw: 'branch-tool-result' });
      const resultText = '\uFEFF  結果🙂e\u0301\r\n<think>[Aborted]</think>  ';
      const literalText = '<think>[Aborted]</think>  \r\n';
      const argumentsText = ' { "n": 1.00, "label": "\\u0061" } ';
      await storage.saveFile({ binaryObjectId, blob: new Blob([resultText], { type: 'text/plain' }), name: 'result.txt', mimeType: 'text/plain' });
      const { chat } = fixture({ status: 'success', content: { type: 'binary_object', id: binaryObjectId } });
      const user = chat.root.items[0]!;
      const assistant = user.replies.items[0]!;
      if (assistant.role !== 'assistant') throw new Error('Missing assistant fixture.');
      const literal = assistant.parts[1];
      const call = assistant.parts[2];
      if (literal?.type !== 'text' || call?.type !== 'tool_call') throw new Error('Missing assistant parts.');
      literal.text = literalText;
      call.toolCall.function.arguments = argumentsText;
      const inactive: AssistantMessageNode = {
        id: toMessageId({ raw: 'inactive' }), role: 'assistant', createdAt: 4,
        modelId: 'test', lmParameters: undefined,
        interruption: { type: 'error', message: '記録済みの失敗' },
        parts: [{ type: 'text', text: 'Other branch [Aborted]  ', completeness: 'partial' }],
        replies: { items: [] },
      };
      user.replies.items.push(inactive);
      const sourceBefore = structuredClone(chat);
      const { restored } = roundTripChatContentPersistenceSerialization({ content: chat });
      expect(restored).toEqual(sourceBefore);

      for (const content of [chat, restored]) {
        const messages = buildChatGenerationMessages({ chat: content, excludedMessageId: undefined, systemPromptMessages: [] });
        expect(messages.map(message => message.id)).toEqual(['user', 'assistant', 'tool']);
        const { result } = await consumeProviderGenerationForTest({ provider, request: {
          debug: undefined, messages, model: 'test', parameters: undefined, tools: undefined, signal: undefined,
          readBinaryObject: async ({ binaryObjectId, signal }) => {
            signal?.throwIfAborted();
            const blob = await storage.getFile({ binaryObjectId });
            if (!blob) throw new Error('Missing stored tool result.');
            return blob;
          },
        } });
        expect(result).toEqual({ type: 'finished', next: 'user' });
      }

      const expected = { model: 'test', stream: true, messages: [
        { role: 'user', content: '質問' },
        { role: 'assistant', content: literalText,
          ...(kind === 'openai' ? { reasoning_content: '  確認する。\n' } : { thinking: '  確認する。\n' }),
          tool_calls: [{ id: 'lookup-1', type: 'function', function: {
            name: 'lookup', arguments: kind === 'openai' ? argumentsText : { n: 1, label: 'a' },
          } }],
        },
        { role: 'tool', content: resultText, tool_call_id: 'lookup-1', ...(kind === 'ollama' ? { tool_name: 'lookup' } : {}) },
      ] };
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(requestBody({ fetcher, index: 0 })).toEqual(expected);
      expect(requestBody({ fetcher, index: 1 })).toEqual(expected);
      expect(chat).toEqual(sourceBefore);
      expect(restored).toEqual(sourceBefore);
    });

    for (const status of ['success', 'error'] as const) {
      it.each(contents)(`${status}: $name stays exact through binary storage and chat reload`, async ({ text }) => {
        const { provider, fetcher } = providerWithRecording({ kind });
        const storage = new MemoryStorageProvider();
        const id = toChatId({ raw: 'stored-tool' });
        const binaryObjectId = toBinaryObjectId({ raw: 'stored-result' });
        const { chat, tool } = fixture({ status, content: { type: 'text', text } });
        const build = ({ content }: { content: ChatContent }) => buildChatGenerationMessages({ chat: content, excludedMessageId: undefined, systemPromptMessages: [] });
        const readBinaryObject: NonNullable<Parameters<LmProvider['chat']>[0]['readBinaryObject']> = async ({ binaryObjectId, signal }) => {
          signal?.throwIfAborted();
          const blob = await storage.getFile({ binaryObjectId });
          if (!blob) throw new Error('Missing saved tool content.');
          return blob;
        };
        const invoke = ({ content }: { content: ChatContent }) => consumeProviderGenerationForTest({ provider, request: {
          debug: undefined, model: 'test', parameters: undefined, tools: undefined, signal: undefined, readBinaryObject,
          messages: build({ content }),
        } });
        expect((await invoke({ content: chat })).result).toEqual({ type: 'finished', next: 'user' });
        await storage.saveFile({ binaryObjectId, blob: new Blob([text], { type: 'text/plain' }), name: 'result.txt', mimeType: 'text/plain' });
        const saved = { type: 'binary_object' as const, id: binaryObjectId };
        const part = tool.parts[0];
        if (!part) throw new Error('Missing tool part.');
        switch (part.result.status) {
        case 'success': part.result.content = saved; break;
        case 'error': part.result.error.message = saved; break;
        case 'executing': throw new Error('Expected a terminal tool outcome.');
        default: { const _ex: never = part.result; throw new Error(`Unhandled result: ${_ex}`); }
        }
        const binaryHistory = build({ content: chat });
        await storage.saveChatContent({ id, content: chat });
        const loaded = await storage.loadChatContent({ id });
        if (!loaded) throw new Error('Missing saved chat.');
        expect(build({ content: loaded })).toEqual(binaryHistory);
        expect((await invoke({ content: loaded })).result).toEqual({ type: 'finished', next: 'user' });
        const resultText = status === 'success' ? text : `Error [other]: ${text}`;
        // Independent expected API bodies: persisted references never become model content.
        const expected = { model: 'test', stream: true, messages: [
          { role: 'user', content: '質問' },
          { role: 'assistant', content: '<think>literal</think>',
            ...(kind === 'openai' ? { reasoning_content: '  確認する。\n' } : { thinking: '  確認する。\n' }),
            tool_calls: [{ id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: kind === 'openai' ? ' {"n": 1} ' : { n: 1 } } }],
          },
          { role: 'tool', content: resultText, tool_call_id: 'lookup-1', ...(kind === 'ollama' ? { tool_name: 'lookup' } : {}) },
        ] };
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(requestBody({ fetcher, index: 0 })).toEqual(expected);
        expect(requestBody({ fetcher, index: 1 })).toEqual(expected);
        expect(build({ content: loaded })).toEqual(binaryHistory);
      });
    }
    it('refuses corrupt UTF-8 before issuing an API request and preserves the history', async () => {
      const { provider, fetcher } = providerWithRecording({ kind });
      const { chat } = fixture({ status: 'success', content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'corrupt' }) } });
      const before = structuredClone(chat);
      const { node, result } = await consumeProviderGenerationForTest({ provider, request: {
        debug: undefined, messages: buildChatGenerationMessages({ chat, excludedMessageId: undefined, systemPromptMessages: [] }),
        model: 'test', parameters: undefined, tools: undefined, signal: undefined,
        readBinaryObject: async () => new Blob([Uint8Array.of(0xff)]),
      } });
      expect(result.type).toBe('error');
      expect(fetcher).not.toHaveBeenCalled();
      expect(node.parts).toEqual([]);
      expect(chat).toEqual(before);
    });
  });
}
