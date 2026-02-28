import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePWAUpdate } from './usePWAUpdate';

describe('usePWAUpdate', () => {
  const { needRefresh, setNeedRefresh, update } = usePWAUpdate();

  beforeEach(() => {
    setNeedRefresh({ refresh: false, handler: undefined });
  });

  it('correctly updates and reads needRefresh state', () => {
    expect(needRefresh.value).toBe(false);

    setNeedRefresh({ refresh: true, handler: undefined });
    expect(needRefresh.value).toBe(true);

    setNeedRefresh({ refresh: false, handler: undefined });
    expect(needRefresh.value).toBe(false);
  });

  it('correctly executes the update handler when update is called', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setNeedRefresh({ refresh: true, handler });

    await update();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not throw when update is called with no handler', async () => {
    setNeedRefresh({ refresh: true, handler: undefined });
    await expect(update()).resolves.toBeUndefined();
  });
});
