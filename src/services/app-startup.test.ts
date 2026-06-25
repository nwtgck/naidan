import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleAppStartup } from './app-startup';

function setReadyState({ value }: { value: DocumentReadyState }): void {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    value,
  });
}

describe('app startup scheduling', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for DOMContentLoaded when the entry evaluates during parsing', async () => {
    setReadyState({ value: 'loading' });
    const bootstrap = vi.fn(async () => {});
    const onWaitingForDom = vi.fn();
    const onFailure = vi.fn();

    scheduleAppStartup({ document, bootstrap, onWaitingForDom, onFailure });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(onWaitingForDom).toHaveBeenCalledOnce();

    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('starts immediately when asynchronous SystemJS evaluation missed DOMContentLoaded', async () => {
    setReadyState({ value: 'complete' });
    const bootstrap = vi.fn(async () => {});
    const onWaitingForDom = vi.fn();

    scheduleAppStartup({
      document,
      bootstrap,
      onWaitingForDom,
      onFailure: vi.fn(),
    });
    await Promise.resolve();

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(onWaitingForDom).not.toHaveBeenCalled();
  });

  it('routes a rejected bootstrap to the explicit failure handler', async () => {
    setReadyState({ value: 'interactive' });
    const failure = new Error('storage initialization failed');
    const onFailure = vi.fn();

    scheduleAppStartup({
      document,
      bootstrap: async () => {
        throw failure;
      },
      onWaitingForDom: vi.fn(),
      onFailure,
    });
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith({ error: failure });
    });
  });
});
