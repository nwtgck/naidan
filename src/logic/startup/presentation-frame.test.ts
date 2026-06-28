import { describe, expect, it, vi } from 'vitest';
import { waitForPresentationPaint } from './presentation-frame';

describe('waitForPresentationPaint', () => {
  it('resolves only after the browser receives a full paint opportunity', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((next: FrameRequestCallback) => {
      callbacks.push(next);
      return callbacks.length;
    });

    const completed = waitForPresentationPaint({
      window: {
        requestAnimationFrame,
      },
    });

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    callbacks.shift()?.(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    let resolved = false;
    void completed.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    callbacks.shift()?.(16);
    await expect(completed).resolves.toBeUndefined();
  });
});
