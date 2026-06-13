import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('installChatBootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('cleans up previous listeners and subscriptions before reinstalling', async () => {
    const { installChatBootstrap } = await import('./chat-bootstrap');
    const firstBeforeUnloadCleanup = vi.fn();
    const firstModelListCleanup = vi.fn();
    const secondBeforeUnloadCleanup = vi.fn();
    const secondModelListCleanup = vi.fn();

    installChatBootstrap({
      registerBeforeUnload: () => firstBeforeUnloadCleanup,
      subscribeModelList: () => firstModelListCleanup,
    });

    expect(firstBeforeUnloadCleanup).not.toHaveBeenCalled();
    expect(firstModelListCleanup).not.toHaveBeenCalled();

    installChatBootstrap({
      registerBeforeUnload: () => secondBeforeUnloadCleanup,
      subscribeModelList: () => secondModelListCleanup,
    });

    expect(firstBeforeUnloadCleanup).toHaveBeenCalledTimes(1);
    expect(firstModelListCleanup).toHaveBeenCalledTimes(1);
    expect(secondBeforeUnloadCleanup).not.toHaveBeenCalled();
    expect(secondModelListCleanup).not.toHaveBeenCalled();
  });
});
