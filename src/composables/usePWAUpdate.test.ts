import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watch } from 'vue';
import { usePWAUpdate } from './usePWAUpdate';

const { status, setUpdateState, update } = usePWAUpdate();

beforeEach(() => setUpdateState({ next: { kind: 'idle' } }));
afterEach(() => setUpdateState({ next: { kind: 'idle' } }));

describe('usePWAUpdate', () => {
  it('shares update availability across consumers', () => {
    expect(status.value).toBe('idle');
    setUpdateState({ next: { kind: 'preparing' } });
    expect(usePWAUpdate().status.value).toBe('preparing');
    setUpdateState({ next: { kind: 'idle' } });
    expect(status.value).toBe('idle');
  });

  it.each(['idle', 'preparing'] as const)('does not update while %s', async kind => {
    setUpdateState({ next: { kind } });
    await expect(update()).resolves.toBeUndefined();
    expect(status.value).toBe(kind);
  });

  it('executes the ready handler only once, including after sending completes', async () => {
    const handler = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'ready', handler } });
    const pending = update();
    expect(status.value).toBe('applying');
    await update();
    await pending;
    await update();
    expect(handler).toHaveBeenCalledOnce();
    expect(status.value).toBe('applying');
  });

  it('accepts the explicit early network action and restores it on failure', async () => {
    const handler = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'preparing', handler } });
    expect(usePWAUpdate().canUpdate.value).toBe(true);
    await expect(update()).rejects.toThrow('offline');
    expect(status.value).toBe('preparing');
    expect(usePWAUpdate().canUpdate.value).toBe(true);
    await update();
    expect(status.value).toBe('applying');
    expect(usePWAUpdate().canUpdate.value).toBe(false);
  });

  it('publishes the handler atomically with ready status', async () => {
    const handler = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const stop = watch(status, value => {
      if (value === 'ready') void update();
    }, { flush: 'sync' });
    try {
      setUpdateState({ next: { kind: 'ready', handler } });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it('restores the action on failure for a deliberate retry', async () => {
    const error = new Error('activation failed');
    const handler = vi.fn<() => Promise<void>>().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'ready', handler } });
    await expect(update()).rejects.toBe(error);
    expect(status.value).toBe('ready');
    await update();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not restore an obsolete action after state changed during failure', async () => {
    const error = new Error('obsolete');
    setUpdateState({ next: { kind: 'ready', handler: async () => {
      setUpdateState({ next: { kind: 'preparing' } });
      throw error;
    } } });
    await expect(update()).rejects.toBe(error);
    expect(status.value).toBe('preparing');
  });

  it('clears the action together with availability', async () => {
    const handler = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'ready', handler } });
    setUpdateState({ next: { kind: 'idle' } });
    await update();
    expect(handler).not.toHaveBeenCalled();
  });
});
