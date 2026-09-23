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
  it('keeps structured install details and warning severity in the real event store', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startPWAUpdateRuntime();
    const onDiagnostic = start.mock.calls[0]![0].onDiagnostic;
    const details = { resourceUrl: 'https://example.test/runtime.wasm.gz', error: { name: 'QuotaExceededError', message: 'cache full' } };
    onDiagnostic({ level: 'error', message: 'Precache failed', details });
    onDiagnostic({ level: 'warn', message: 'Cause unavailable', details: { kind: 'worker-became-redundant' } });
    const events = useGlobalEvents();
    expect(events.events.value).toEqual([
      expect.objectContaining({ type: 'error', source: 'PWA', message: 'Precache failed', details }),
      expect.objectContaining({ type: 'warn', source: 'PWA', message: 'Cause unavailable' }),
    ]);
    expect(events.errorCount.value).toBe(1);
  });

});
