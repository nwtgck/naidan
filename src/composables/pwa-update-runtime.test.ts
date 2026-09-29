import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPWAUpdateController } from '@/logic/pwa/update-controller';
import { startPWAUpdateRuntime, TEST_ONLY } from '@/composables/pwa-update-runtime';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useGlobalEvents } from '@/composables/useGlobalEvents';

vi.mock('@/logic/pwa/update-controller', () => ({ createPWAUpdateController: vi.fn() }));
const start = vi.mocked(createPWAUpdateController);
const dispose = vi.fn();

beforeEach(async () => {
  TEST_ONLY.reset(); start.mockReset(); dispose.mockReset(); useGlobalEvents().clearEvents();
  start.mockReturnValue({ dispose });
  vi.stubGlobal('navigator', { serviceWorker: {} });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  TEST_ONLY.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('page-scoped PWA runtime', () => {
  it('registers once even if PWAManager is remounted', () => {
    startPWAUpdateRuntime(); startPWAUpdateRuntime();
    expect(start).toHaveBeenCalledOnce();
  });
  it('publishes early actions to the real shared state', () => {
    startPWAUpdateRuntime();
    start.mock.calls[0]![0].onState({ next: { kind: 'preparing', handler: async () => {} } });
    expect(usePWAUpdate().status.value).toBe('preparing');
    expect(usePWAUpdate().canUpdate.value).toBe(true);
  });
  it('ignores environments without service workers', () => {
    vi.stubGlobal('navigator', {}); startPWAUpdateRuntime(); expect(start).not.toHaveBeenCalled();
  });
  it('disposes page-level listeners when the test runtime is reset', () => {
    startPWAUpdateRuntime(); TEST_ONLY.reset(); expect(dispose).toHaveBeenCalledOnce();
    expect(usePWAUpdate().status.value).toBe('idle');
  });
  it('keeps original update errors in the application event log', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    startPWAUpdateRuntime();
    const error = new Error('worker did not activate');
    start.mock.calls[0]![0].onError({ message: 'Failed to apply the application update.', error });
    expect(useGlobalEvents().events.value).toEqual([
      expect.objectContaining({ type: 'error', source: 'PWA', message: 'Failed to apply the application update.' }),
    ]);
    expect(useGlobalEvents().events.value[0]?.details).toBe(error);
  });
  it('records an honest warning without synthesizing a resource failure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startPWAUpdateRuntime();
    start.mock.calls[0]![0].onWarning({ message: 'Preparation stopped; check worker console.' });
    expect(useGlobalEvents().events.value).toEqual([
      expect.objectContaining({ type: 'warn', source: 'PWA', message: 'Preparation stopped; check worker console.' }),
    ]);
    expect(useGlobalEvents().errorCount.value).toBe(0);
  });
});
