import { describe, expect, it, vi } from 'vitest';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import { createInferenceEventDelivery, TEST_ONLY } from './inference-event-delivery';

const delta = ({ text }: { text: string }): InferenceGenerationEvent => ({ type: 'text_delta', index: 0, text });

describe('bounded native event acknowledgement', () => {
  it('copies accepted data and waits for ordered acknowledgements', async () => {
    const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const seen: InferenceGenerationEvent[] = [];
    const owner = createInferenceEventDelivery({ onFailure: vi.fn(), onEvent: async ({ event }) => {
      seen.push(event); if (seen.length === 1) {
        started.resolve(); await release.promise;
      }
    } });
    const event = delta({ text: ' A ' });
    owner.enqueue({ event }); if (event.type === 'text_delta') event.text = 'MUTATED';
    owner.enqueue({ event: delta({ text: 'B' }) });
    let finished = false; const pending = owner.finish().then(() => {
      finished = true;
    });
    await started.promise; expect(seen).toEqual([delta({ text: ' A ' })]); expect(finished).toBe(false);
    release.resolve(); await pending; expect(seen).toEqual([delta({ text: ' A ' }), delta({ text: 'B' })]);
    expect(() => owner.enqueue({ event })).toThrow('closed');
  });
  it('interrupts overflow while still draining all earlier accepted data', async () => {
    const onFailure = vi.fn(); const seen: string[] = [];
    const owner = createInferenceEventDelivery({ onFailure, onEvent: ({ event }) => {
      if (event.type === 'text_delta') seen.push(event.text);
    } });
    for (let i = 0; i < TEST_ONLY.limits.events; i++) owner.enqueue({ event: delta({ text: String(i) }) });
    expect(() => owner.enqueue({ event: delta({ text: 'unaccepted' }) })).toThrow('limit');
    await expect(owner.finish()).rejects.toThrow('limit');
    expect(onFailure).toHaveBeenCalledOnce(); expect(seen).toHaveLength(TEST_ONLY.limits.events);
    expect(seen.at(-1)).toBe(String(TEST_ONLY.limits.events - 1));
  });
  it('bounds text size and restores capacity after successful deliveries', async () => {
    let owner = createInferenceEventDelivery({ onFailure: vi.fn(), onEvent: vi.fn() });
    expect(() => owner.enqueue({ event: delta({ text: 'x'.repeat(TEST_ONLY.limits.textCodeUnits + 1) }) })).toThrow('limit');
    await expect(owner.finish()).rejects.toThrow('limit');
    const onEvent = vi.fn(); owner = createInferenceEventDelivery({ onFailure: vi.fn(), onEvent });
    for (let i = 0; i < TEST_ONLY.limits.events + 5; i++) {
      owner.enqueue({ event: delta({ text: 'same' }) });
      // Let the small synchronous test producer yield; no deduplication is allowed.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    await owner.finish(); expect(onEvent).toHaveBeenCalledTimes(TEST_ONLY.limits.events + 5);
  });
  it('does not retry a failed consumer and preserves its failure', async () => {
    const error = new Error('host failed'); const onFailure = vi.fn(() => {
      throw new Error('interrupt failed');
    });
    const onEvent = vi.fn(async () => {
      throw error;
    });
    const owner = createInferenceEventDelivery({ onFailure, onEvent });
    owner.enqueue({ event: delta({ text: 'A' }) }); owner.enqueue({ event: delta({ text: 'B' }) });
    await expect(owner.finish()).rejects.toBe(error);
    expect(onFailure).toHaveBeenCalledOnce(); expect(onEvent).toHaveBeenCalledOnce();
  });
});
