import { describe, expect, it, vi } from 'vitest';
import { createGenerationDelivery } from './generation-delivery';

describe('generation callback delivery ownership', () => {
  it('acknowledges chunks in order before tool delivery and settlement', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const owner = createGenerationDelivery({ onFailure: vi.fn() });
    owner.enqueue({ deliver: async () => {
      events.push('first-start');
      entered.resolve();
      await release.promise;
      events.push('first-end');
    } });
    owner.enqueue({ deliver: () => {
      events.push('second');
    } });
    owner.enqueue({ deliver: () => {
      events.push('tools');
    } });
    const finished = owner.finish().then(() => {
      events.push('settled');
    });
    await entered.promise;
    expect(events).toEqual(['first-start']);
    release.resolve();
    await finished;
    expect(events).toEqual(['first-start', 'first-end', 'second', 'tools', 'settled']);
    const late = vi.fn();
    owner.enqueue({ deliver: late });
    await owner.finish();
    expect(late).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)('observes callback %s before production closes and stops later delivery', async kind => {
    const failure = new Error('Host callback failed');
    const failed = Promise.withResolvers<void>();
    const interrupted = vi.fn(() => {
      failed.resolve();
    });
    const owner = createGenerationDelivery({ onFailure: interrupted });
    owner.enqueue({ deliver: () => {
      if (kind === 'throw') throw failure;
      return Promise.reject(failure);
    } });
    const later = vi.fn();
    owner.enqueue({ deliver: later });
    await failed.promise;
    // Failure is observed while the producer is still open, even without
    // anyone awaiting finish yet. Vitest also rejects unhandled rejections.
    owner.enqueue({ deliver: later });
    await expect(owner.finish()).rejects.toBe(failure);
    expect(interrupted).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  });

  it('preserves a non-Error rejection even when interruption throws', async () => {
    const owner = createGenerationDelivery({ onFailure: () => {
      throw new Error('Interrupt failed');
    } });
    owner.enqueue({ deliver: () => Promise.reject(undefined) });
    await expect(owner.finish()).rejects.toBeUndefined();
  });
});
