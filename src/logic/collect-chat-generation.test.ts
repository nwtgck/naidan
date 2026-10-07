import { describe, expect, it, vi } from 'vitest';
import { createChatGenerationStream } from './create-chat-generation-stream';
import { collectChatGeneration } from './collect-chat-generation';

describe('text-only generation consumers', () => {
  it('drains reasoning children without adding their text to the returned title', async () => {
    const controller = new AbortController();
    const { text, result } = await collectChatGeneration({
      abortController: controller,
      items: createChatGenerationStream({
      signal: controller.signal,
      run: async ({ writer }) => {
      for (let i = 0; i < 25; i++) {
        await writer.text({ type: 'reasoning', text: 'reason'.repeat(10_000) });
        await writer.text({ type: 'text', text: 'T' });
      }
      return { type: 'finished', next: 'user' };
    },
    }),
    });
    expect(text).toBe('T'.repeat(25)); expect(result.type).toBe('finished');
  });
  it('retains received text on a generation failure for the caller to inspect', async () => {
    const controller = new AbortController();
    const { text, result } = await collectChatGeneration({
      abortController: controller,
      items: createChatGenerationStream({
      signal: controller.signal,
      run: async ({ writer }) => {
      await writer.text({ type: 'text', text: '<think>literal' }); throw new Error('offline');
    },
    }),
    });
    expect(text).toBe('<think>literal'); expect(result.type).toBe('error');
  });
  it('preserves an interrupted result instead of declaring a partial title successful', async () => {
    const controller = new AbortController();
    const { text, result } = await collectChatGeneration({
      abortController: controller,
      items: createChatGenerationStream({
      signal: controller.signal,
      run: async ({ writer }) => {
      await writer.text({ type: 'text', text: 'partial' }); return { type: 'interrupted', reason: 'limit' };
    },
    }),
    });
    expect(text).toBe('partial'); expect(result).toEqual({ type: 'interrupted', reason: 'limit' });
  });
  it.each(['throws', 'rejects', 'stalls'] as const)('does not let a display observer that %s own stream consumption', async failure => {
    const controller = new AbortController();
    const observer = vi.fn(() => {
      if (failure === 'throws') throw new Error('display');
      if (failure === 'rejects') return Promise.reject(new Error('display'));
      return new Promise<void>(() => {});
    });
    const { text, result } = await collectChatGeneration({
      abortController: controller,
      onText: observer,
      items: createChatGenerationStream({
        signal: controller.signal,
        run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'hello' });
        await writer.text({ type: 'text', text: ' world' });
        return { type: 'finished', next: 'user' };
      },
      }),
    });
    expect(text).toBe('hello world'); expect(result).toEqual({ type: 'finished', next: 'user' });
    expect(controller.signal.aborted).toBe(false); expect(observer).toHaveBeenCalledWith({ text: 'hello world' });
  });

});
