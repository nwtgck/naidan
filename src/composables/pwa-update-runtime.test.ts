import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPWAUpdateController } from '@/logic/pwa/update-controller';
import { startPWAUpdateRuntime, TEST_ONLY } from '@/composables/pwa-update-runtime';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { ensureAllStringsForTest } from '@/strings/test-utils';

vi.mock('@/logic/pwa/update-controller', () => ({ createPWAUpdateController: vi.fn() }));
const start = vi.mocked(createPWAUpdateController);
const dispose = vi.fn();

beforeEach(async () => {
  TEST_ONLY.reset(); start.mockReset(); dispose.mockReset();
  start.mockReturnValue({ dispose });
  vi.stubGlobal('navigator', { serviceWorker: {} });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  TEST_ONLY.reset(); vi.unstubAllGlobals();
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
});
