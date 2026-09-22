import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatContent, AssistantMessageNode, ToolMessageNode, UserMessageNode } from '@/01-models/types';
import type { LmProvider, ChatGenerationItem } from '@/01-models/lm';
import type { Tool } from '@/01-models/tool';
import { toChatId, toMessageId, toToolCallId } from '@/01-models/ids';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { consumeChatGeneration } from './consume-chat-generation';
import { executeChatToolCalls } from './execute-chat-tool-calls';
import { buildChatGenerationMessages } from './build-chat-generation-messages';

function assistant({ id }: { id: string }): AssistantMessageNode {
  return { id: toMessageId({ raw: id }), role: 'assistant', createdAt: 13, modelId: 'fixture', lmParameters: undefined, interruption: undefined, parts: [], replies: { items: [] } };
}
async function* strings({ values }: { values: string[] }): AsyncGenerator<string, void, void> {
  yield* values;
}
async function* items({ values }: { values: ChatGenerationItem[] }): AsyncGenerator<ChatGenerationItem, void, void> {
  yield* values;
}

describe('generation, execution, and persisted model history', () => {
  it('rebuilds the same next request after storing reasoning, literal text, calls, and tool results', async () => {
    const store = new MemoryStorageProvider(); const chatId = toChatId({ raw: 'chat' });
    const first = assistant({ id: 'first' });
    const user: UserMessageNode = { id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 12, modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: 'Calculate', completeness: 'complete' }], replies: { items: [first] } };
    const content: ChatContent = { root: { items: [user] }, currentLeafId: first.id };
    const controller = new AbortController();
    const provider: LmProvider = {
      chat: vi.fn<LmProvider['chat']>().mockImplementationOnce(() => items({ values: [
        { type: 'reasoning', partId: 'r', index: 0, chunks: strings({ values: ['  Check', '\n'] }), completeness: Promise.resolve('complete') },
        { type: 'text', partId: 't', index: 1, chunks: strings({ values: ['<think>literal</think>', '  '] }), completeness: Promise.resolve('complete') },
        { type: 'tool_call', partId: 'c', index: 3, toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'double', arguments: ' { } ' } } },
        { type: 'result', result: { type: 'finished', next: 'tool_results' } },
      ] })).mockImplementationOnce(() => items({ values: [
        { type: 'text', partId: 't', index: 0, chunks: strings({ values: ['8', 'です。'] }), completeness: Promise.resolve('complete') },
        { type: 'result', result: { type: 'finished', next: 'user' } },
      ] })),
      listModels: async () => ['fixture'],
    };
    const declarations = [{ name: 'double', description: 'Double', parameters: { type: 'object', properties: { n: { type: 'number' } } } }];
    const generate = ({ node }: { node: AssistantMessageNode }) => consumeChatGeneration({
      onToolCallDraftsChange: undefined,
      node, abortController: controller, onChange: () => {},
      items: provider.chat({ debug: undefined, messages: buildChatGenerationMessages({ chat: content, excludedMessageId: node.id, systemPromptMessages: ['system'] }), model: 'fixture', parameters: undefined, tools: declarations, readBinaryObject: undefined, signal: controller.signal }),
    });
    expect(await generate({ node: first })).toEqual({ type: 'finished', next: 'tool_results' });
    const toolNode: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 14, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] } };
    first.replies.items.push(toolNode); content.currentLeafId = toolNode.id;
    const execute = vi.fn<Tool['execute']>(async ({ args }) => ({ status: 'success', content: String(z.object({ n: z.number() }).parse(args).n * 2) }));
    await executeChatToolCalls({ calls: first.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall), tools: [{ name: 'double', description: 'Double', parametersSchema: z.object({ n: z.number().default(4) }), execute }], node: toolNode, signal: controller.signal, approvalContext: undefined, onEvent: () => {}, onChange: () => {}, persistContent: async ({ text }) => ({ type: 'text', text }) });
    expect(execute).toHaveBeenCalledTimes(1);
    const second = assistant({ id: 'second' }); toolNode.replies.items.push(second); content.currentLeafId = second.id;
    const before = buildChatGenerationMessages({ chat: content, excludedMessageId: second.id, systemPromptMessages: ['system'] });
    await store.saveChatContent({ id: chatId, content });
    const loaded = await store.loadChatContent({ id: chatId });
    if (!loaded) throw new Error('Missing saved chat.');
    expect(buildChatGenerationMessages({ chat: loaded, excludedMessageId: second.id, systemPromptMessages: ['system'] })).toEqual(before);
    expect(before[2]?.parts).toMatchObject([
      { type: 'reasoning', text: '  Check\n', completeness: 'complete' },
      { type: 'text', text: '<think>literal</think>  ', completeness: 'complete' },
      { type: 'tool_call', toolCall: { function: { arguments: ' { } ' } } },
    ]);
    expect(before[3]?.parts).toMatchObject([{ type: 'tool_result', result: { status: 'success', content: { type: 'text', text: '8' } } }]);
    expect(await generate({ node: second })).toEqual({ type: 'finished', next: 'user' });
    expect(second.parts).toEqual([{ type: 'text', text: '8です。', completeness: 'complete' }]);
    expect(first.parts).toEqual(before[2]?.parts);
    await store.saveChatContent({ id: chatId, content });
    const completed = await store.loadChatContent({ id: chatId });
    expect(completed?.currentLeafId).toBe(second.id);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps received partial text and a localized interruption in an unselected branch', async () => {
    const store = new MemoryStorageProvider(); const chatId = toChatId({ raw: 'chat' });
    const stopped = assistant({ id: 'stopped' }); const other = assistant({ id: 'other' });
    const controller = new AbortController();
    await consumeChatGeneration({ onToolCallDraftsChange: undefined, node: stopped, abortController: controller, onChange: () => {}, items: items({ values: [
      { type: 'text', partId: 'p', index: 0, chunks: strings({ values: ['<thi', 'nk>literal</think>', '\ud83d', '\ude42'] }), completeness: Promise.resolve('partial') },
      { type: 'result', result: { type: 'error', error: new Error('offline') } },
    ] }) });
    // The caller owns cause attribution and the recorded display language.
    stopped.interruption = { type: 'error', message: '記録済みの説明: offline' };
    const content: ChatContent = { root: { items: [stopped, other] }, currentLeafId: other.id };
    await store.saveChatContent({ id: chatId, content });
    const loaded = await store.loadChatContent({ id: chatId });
    expect(loaded?.root.items[0]).toMatchObject({ createdAt: 13, interruption: { type: 'error', message: '記録済みの説明: offline' }, parts: [{ text: '<think>literal</think>🙂', completeness: 'partial' }] });
    expect(stopped.parts[0]).toMatchObject({ completeness: 'partial' });
  });
});
