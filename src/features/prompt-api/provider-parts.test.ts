import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptApiProvider } from './provider';
import { BROWSER_PROVIDED_LM_MODEL_ID } from './constants';
import { TEST_ONLY as RUNTIME } from './runtime';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { toMessageId } from '@/01-models/ids';
import type { AssistantMessageNode, ChatMessage } from '@/01-models/types';

function node(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'generated' }), role: 'assistant', createdAt: 1, parts: [], interruption: undefined, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
}
function history(): ChatMessage[] {
  return [{ id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ id: 't', type: 'text', text: 'original', completeness: 'complete' }] }];
}
function chat({ messages, controller }: { messages: ChatMessage[], controller: AbortController }) {
  return new PromptApiProvider().chat({ debug: undefined, messages, model: BROWSER_PROVIDED_LM_MODEL_ID, parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: controller.signal });
}
function browser({ stream }: { stream: ReadableStream<string> }) {
  const destroy = vi.fn(); const promptStreaming = vi.fn((_prompt: import('./language-model').PromptApiPrompt) => stream);
  const create = vi.fn(async () => ({ destroy, promptStreaming }));
  vi.stubGlobal('LanguageModel', { availability: vi.fn().mockResolvedValue('available'), create });
  return { create, destroy, promptStreaming };
}
afterEach(() => {
  RUNTIME.reset(); vi.unstubAllGlobals();
});

describe('Prompt API parts and ownership', () => {
  it('captures the input before reading and starts the model lazily', async () => {
    const b = browser({ stream: new ReadableStream({ start(c) {
      c.enqueue('<think>literal</think>  '); c.enqueue('  '); c.close();
    } }) });
    const controller = new AbortController(); const messages = history(); const items = chat({ messages, controller });
    const first = messages[0]?.parts[0]; if (first?.type !== 'text') throw new Error('Expected text fixture.');
    first.text = 'mutated';
    expect(b.create).not.toHaveBeenCalled(); const n = node();
    const result = await consumeChatGeneration({ node: n, items, abortController: controller, onChange: () => {} });
    expect(b.promptStreaming.mock.calls[0]?.[0]).toBe('original');
    expect(result).toEqual({ type: 'finished', next: 'user' });
    expect(n.parts).toEqual([{ id: 'part_0', type: 'text', text: '<think>literal</think>    ', completeness: 'complete' }]);
    expect(b.destroy).toHaveBeenCalledOnce();
  });
  it('cancels an uncooperative pending browser read and keeps accepted text partial', async () => {
    const cancel = vi.fn(); const b = browser({ stream: new ReadableStream({ start(c) {
      c.enqueue('途中');
    }, cancel }) });
    const controller = new AbortController(); const n = node();
    const result = await consumeChatGeneration({ node: n, items: chat({ messages: history(), controller }), abortController: controller, onChange: () => {
      if (n.parts.some(p => p.type === 'text' && p.text === '途中')) controller.abort();
    } });
    expect(result).toEqual({ type: 'interrupted', reason: 'aborted' });
    expect(n.parts).toMatchObject([{ type: 'text', text: '途中', completeness: 'partial' }]);
    expect(cancel).toHaveBeenCalledOnce(); expect(b.destroy).toHaveBeenCalledOnce();
  });
  it('rejects an invalid browser chunk without losing earlier text', async () => {
    let i = 0;
    const b = browser({ stream: new ReadableStream({ pull(c) {
      if (i++ === 0) c.enqueue('kept'); else c.enqueue(42 as never);
    } }) });
    const n = node(); const controller = new AbortController();
    const result = await consumeChatGeneration({ node: n, items: chat({ messages: history(), controller }), abortController: controller, onChange: () => {} });
    expect(result.type).toBe('error'); expect(n.parts).toMatchObject([{ text: 'kept', completeness: 'partial' }]); expect(b.destroy).toHaveBeenCalledOnce();
  });
  it('does not acquire a session for a signal already aborted', async () => {
    const b = browser({ stream: new ReadableStream({ start(c) {
      c.close();
    } }) });
    const controller = new AbortController(); controller.abort(); const n = node();
    const result = await consumeChatGeneration({ node: n, items: chat({ messages: history(), controller }), abortController: controller, onChange: () => {} });
    expect(result).toEqual({ type: 'interrupted', reason: 'aborted' }); expect(n.parts).toEqual([]); expect(b.create).not.toHaveBeenCalled();
  });
  it('destroys a late-created session if abort happened during creation', async () => {
    const session = Promise.withResolvers<{ destroy: () => void, promptStreaming: () => ReadableStream<string> }>();
    const destroy = vi.fn(); const promptStreaming = vi.fn();
    const create = vi.fn(() => session.promise); vi.stubGlobal('LanguageModel', { availability: vi.fn().mockResolvedValue('available'), create });
    const controller = new AbortController(); const n = node();
    const task = consumeChatGeneration({ node: n, items: chat({ messages: history(), controller }), abortController: controller, onChange: () => {} });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce()); controller.abort(); session.resolve({ destroy, promptStreaming });
    expect(await task).toEqual({ type: 'interrupted', reason: 'aborted' }); expect(n.parts).toEqual([]);
    expect(promptStreaming).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledOnce();
  });
  it('rejects unsupported reasoning before creating a browser session', async () => {
    const b = browser({ stream: new ReadableStream({ start(c) {
      c.close();
    } }) }); const controller = new AbortController();
    const messages: ChatMessage[] = [{ id: toMessageId({ raw: 'a' }), role: 'assistant', parts: [{ id: 'r', type: 'reasoning', text: 'R', completeness: 'partial' }] }, ...history()];
    const n = node(); const result = await consumeChatGeneration({ node: n, items: chat({ messages, controller }), abortController: controller, onChange: () => {} });
    expect(result).toMatchObject({ type: 'error', error: { code: 'unsupported_input' } });
    expect(n.parts).toEqual([]); expect(b.create).not.toHaveBeenCalled();
  });
});
