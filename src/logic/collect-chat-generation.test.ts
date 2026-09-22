import { describe, expect, it } from 'vitest';
import { createChatGenerationStream } from './create-chat-generation-stream';
import { collectChatGeneration } from './collect-chat-generation';

describe('text-only generation consumers', () => {
  it('drains reasoning children without adding their text to the returned title', async () => {
    const controller = new AbortController();
    const { text, result } = await collectChatGeneration({ abortController: controller, items: createChatGenerationStream({ signal: controller.signal, run: async ({ writer }) => {
      for (let i = 0; i < 25; i++) {
        await writer.text({ type: 'reasoning', text: 'reason'.repeat(10_000) });
        await writer.text({ type: 'text', text: 'T' });
      }
      return { type: 'finished', next: 'user' };
    } }) });
    expect(text).toBe('T'.repeat(25)); expect(result.type).toBe('finished');
  });
  it('retains received text on a generation failure for the caller to inspect', async () => {
    const controller = new AbortController();
    const { text, result } = await collectChatGeneration({ abortController: controller, items: createChatGenerationStream({ signal: controller.signal, run: async ({ writer }) => {
      await writer.text({ type: 'text', text: '<think>literal' }); throw new Error('offline');
    } }) });
    expect(text).toBe('<think>literal'); expect(result.type).toBe('error');
  });
  it('preserves an interrupted result instead of declaring a partial title successful', async () => {
    const controller = new AbortController();
    const { text, result } = await collectChatGeneration({ abortController: controller, items: createChatGenerationStream({ signal: controller.signal, run: async ({ writer }) => {
      await writer.text({ type: 'text', text: 'partial' }); return { type: 'interrupted', reason: 'limit' };
    } }) });
    expect(text).toBe('partial'); expect(result).toEqual({ type: 'interrupted', reason: 'limit' });
  });
});
