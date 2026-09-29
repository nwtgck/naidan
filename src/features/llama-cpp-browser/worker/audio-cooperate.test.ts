import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioCooperator } from './audio-cooperate';
afterEach(() => {
  vi.restoreAllMocks();
});
describe('bounded task yields during audio generation', () => {
  it('yields once across fast frames and again after its responsiveness deadline', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const cooperate = createAudioCooperator({ signal: undefined });
    for (let i = 0; i < 100; i++) await cooperate({ force: false });
    expect(timer).toHaveBeenCalledTimes(1);
    now.mockReturnValue(117); await cooperate({ force: false });
    expect(timer).toHaveBeenCalledTimes(2);
    await cooperate({ force: true }); expect(timer).toHaveBeenCalledTimes(3);
  });
  it('runs task-queued cancellation at the final boundary even after fast frames', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const controller = new AbortController(); const cooperate = createAudioCooperator({ signal: controller.signal });
    await cooperate({ force: false });
    setTimeout(() => controller.abort(), 0);
    await expect(cooperate({ force: true })).rejects.toThrow('aborted');
  });
  it('checks cancellation before scheduling a task', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createAudioCooperator({ signal: controller.signal })({ force: false })).rejects.toThrow('aborted');
  });
});
