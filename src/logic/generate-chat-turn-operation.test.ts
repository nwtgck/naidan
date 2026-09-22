import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LmProvider } from '@/01-models/lm';
import type { MessageNode, AssistantMessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { generateChatTurn } from './generate-chat-turn';
import { createChatGenerationStream } from './create-chat-generation-stream';

function fixture({ provider, tools }: { provider: LmProvider, tools: Tool[] }) {
  const history: MessageNode[] = [];
  const abortController = new AbortController();
  const parameters = { ...EMPTY_LM_PARAMETERS, stop: ['original'] };
  return {
    history, abortController, parameters,
    run: () => generateChatTurn({
      provider, debug: 'on', model: 'fixture', parameters, tools, readBinaryObject: undefined,
      abortController, approvalContext: undefined,
      createAssistantMessage: () => {
        const node: AssistantMessageNode = { id: toMessageId({ raw: `a${history.length}` }), role: 'assistant',
          createdAt: 1, parts: [], interruption: undefined, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
        history.push(node); return node;
      },
      createToolMessage: () => {
        const node: Extract<MessageNode, { role: 'tool' }> = { id: toMessageId({ raw: `t${history.length}` }), role: 'tool',
          createdAt: 1, parts: [], modelId: undefined, lmParameters: undefined, replies: { items: [] } };
        history.push(node); return node;
      },
      buildMessages: ({ excludedMessageId }) => history.filter(node => node.id !== excludedMessageId).map(node => createChatMessageSnapshot({ node })),
      onChange: () => {}, onToolEvent: () => {}, persistToolContent: async ({ text }) => ({ type: 'text', text }),
      describeError: ({ error }) => error.message,
    }),
  };
}

function response({ signal }: Parameters<LmProvider['chat']>[0]) {
  return createChatGenerationStream({ signal, run: async ({ writer }) => {
    await writer.text({ type: 'text', text: 'answer' }); return { type: 'finished', next: 'user' };
  } });
}

describe('chat runtime operation ownership', () => {
  it('keeps stateless Providers on their ordinary single-message chat contract', async () => {
    const chat = vi.fn<LmProvider['chat']>(response);
    const f = fixture({ provider: { chat, listModels: async () => [] }, tools: [] });
    expect(await f.run()).toEqual({ type: 'finished', next: 'user' });
    expect(chat).toHaveBeenCalledOnce(); expect(f.history).toHaveLength(1);
  });

  it('holds one operation over generation, tool approval/execution and the next generation', async () => {
    const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const trace: string[] = [];
    let open = false; let calls = 0;
    const execute = vi.fn<Tool['execute']>(async () => {
      expect(open).toBe(true); trace.push('tool'); held.resolve(); await release.promise;
      expect(open).toBe(true); return { status: 'success', content: 'value' };
    });
    const scoped: LmProvider['chat'] = ({ signal, messages, debug }) => createChatGenerationStream({ signal, run: async ({ writer }) => {
      expect(open).toBe(true); expect(debug).toBe('on'); trace.push(`generate:${messages.length}`);
      if (calls++ === 0) {
        await writer.call({ key: 0, toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: ' {} ' } } });
        return { type: 'finished', next: 'tool_results' };
      }
      expect(messages.map(message => message.role)).toEqual(['assistant', 'tool']);
      await writer.text({ type: 'text', text: 'answer' }); return { type: 'finished', next: 'user' };
    } });
    const hook = vi.fn<NonNullable<LmProvider['runChatOperation']>>(async ({ operation, signal }) => {
      open = true; trace.push('open');
      try {
        await operation({ chat: scoped, signal: signal ?? new AbortController().signal });
      } finally {
        open = false; trace.push('close');
      }
    });
    const direct = vi.fn<LmProvider['chat']>(response);
    const f = fixture({ provider: { chat: direct, runChatOperation: hook, listModels: async () => [] },
      tools: [{ name: 'f', description: 'fixture', parametersSchema: z.object({}), execute }] });
    const pending = f.run();
    try {
      await held.promise; expect(open).toBe(true); expect(trace).toEqual(['open', 'generate:0', 'tool']);
      release.resolve(); expect(await pending).toEqual({ type: 'finished', next: 'user' });
      expect(trace).toEqual(['open', 'generate:0', 'tool', 'generate:2', 'close']);
      expect(hook).toHaveBeenCalledOnce(); expect(direct).not.toHaveBeenCalled(); expect(execute).toHaveBeenCalledOnce();
    } finally {
      release.resolve(); await pending;
    }
  });

  it('freezes parameter and tool declaration values before waiting for admission', async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const received: Parameters<LmProvider['chat']>[0][] = [];
    const provider: LmProvider = { chat: response, listModels: async () => [], runChatOperation: async ({ operation, signal }) => {
      entered.resolve(); await release.promise;
      await operation({ signal: signal ?? new AbortController().signal, chat: args => {
        received.push(args); return response(args);
      } });
    } };
    const tool: Tool = { name: 'f', description: 'before', parametersSchema: z.object({}), execute: async () => ({ status: 'success', content: '' }) };
    const f = fixture({ provider, tools: [tool] }); const pending = f.run();
    await entered.promise; f.parameters.stop[0] = 'changed'; tool.description = 'after'; release.resolve(); await pending;
    expect(received[0]?.parameters?.stop).toEqual(['original']); expect(received[0]?.tools?.[0]?.description).toBe('before');
  });

  it('propagates revoked runtime ownership to a waiting tool instead of starting another generation', async () => {
    const owner = new AbortController(); let count = 0;
    const provider: LmProvider = { chat: response, listModels: async () => [], runChatOperation: async ({ operation }) => {
      await operation({ signal: owner.signal, chat: ({ signal }) => createChatGenerationStream({ signal, run: async ({ writer }) => {
        count++; await writer.call({ key: 0, toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: '{}' } } });
        return { type: 'finished', next: 'tool_results' };
      } }) });
    } };
    const failure = new Error('runtime replaced');
    const tool: Tool = { name: 'f', description: '', parametersSchema: z.object({}), execute: async ({ signal }) => {
      owner.abort(failure); expect(signal?.aborted).toBe(true); return { status: 'success', content: 'observed' };
    } };
    const f = fixture({ provider, tools: [tool] }); await expect(f.run()).rejects.toBe(failure);
    expect(count).toBe(1); expect(f.abortController.signal.aborted).toBe(false);
    expect(f.history[1]?.parts[0]).toMatchObject({ type: 'tool_result', result: { status: 'success', content: { text: 'observed' } } });
  });

  it('does not treat an operation that never invokes its callback as a successful turn', async () => {
    const f = fixture({ provider: { chat: response, listModels: async () => [], runChatOperation: async () => {} }, tools: [] });
    await expect(f.run()).rejects.toThrow('did not run'); expect(f.history).toHaveLength(1); expect(f.history[0]?.parts).toEqual([]);
  });

  it('rejects a duplicated operation callback before creating a second assistant', async () => {
    const f = fixture({ provider: { chat: response, listModels: async () => [], runChatOperation: async ({ operation, signal }) => {
      const scoped = { chat: response, signal: signal ?? new AbortController().signal };
      await operation(scoped); await operation(scoped);
    } }, tools: [] });
    await expect(f.run()).rejects.toThrow('exactly once'); expect(f.history).toHaveLength(1);
  });

  it('removes the runtime abort relay after the operation settles', async () => {
    const owner = new AbortController();
    const f = fixture({ provider: { chat: response, listModels: async () => [], runChatOperation: async ({ operation }) => operation({ chat: response, signal: owner.signal }) }, tools: [] });
    await f.run(); owner.abort(); expect(f.abortController.signal.aborted).toBe(false);
  });
});
