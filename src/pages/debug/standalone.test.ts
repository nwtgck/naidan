import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  debugRunFileProtocolStandaloneVerification: vi.fn(),
  debugVerifyFileProtocolStandaloneWorkerFactory: vi.fn(),
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}));

vi.mock('@/services/debug-file-protocol-standalone/verification/report', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/debug-file-protocol-standalone/verification/report')>();
  return {
    ...original,
    debugRunFileProtocolStandaloneVerification: mocks.debugRunFileProtocolStandaloneVerification,
  };
});

vi.mock('@/services/debug-file-protocol-standalone/verification/worker-probe', () => ({
  debugVerifyFileProtocolStandaloneWorkerFactory: mocks.debugVerifyFileProtocolStandaloneWorkerFactory,
}));

import {
  DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
  type DebugFileProtocolStandaloneVerificationReport,
} from '@/services/debug-file-protocol-standalone/verification/report';
import StandaloneVerificationPage from './standalone.vue';

function createDebugVerificationReport({
  passed = 12,
  failed = 0,
}: {
  passed?: number,
  failed?: number,
} = {}): DebugFileProtocolStandaloneVerificationReport {
  return {
    format: 'naidan-standalone-verification-v1',
    generatedAt: '2026-06-23T00:00:00.000Z',
    status: failed === 0 ? 'pass' : 'fail',
    summary: {
      passed,
      failed,
      durationMs: 12,
    },
    environment: {
      href: `file:///__nonexistent_file_protocol_test_root__/index.html#${DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH}`,
      protocol: 'file:',
      origin: 'null',
      userAgent: 'test-agent',
      readyState: 'complete',
      performanceMemory: undefined,
    },
    checks: [],
    runtime: {
      pluginDiagnostics: undefined,
      startup: undefined,
      systemJsPatch: undefined,
      systemJsRetry: undefined,
      worker: undefined,
      resourceEntries: [],
    },
  };
}

function createDeferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{
      path: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      name: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      component: StandaloneVerificationPage,
    }],
  });
  await router.push(DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH);
  await router.isReady();

  return {
    router,
    wrapper: mount(StandaloneVerificationPage, {
      global: { plugins: [router] },
    }),
  };
}

describe('standalone verification page', () => {
  beforeEach(() => {
    vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', true);
    vi.clearAllMocks();
    mocks.debugRunFileProtocolStandaloneVerification.mockResolvedValue(createDebugVerificationReport());
    mocks.debugVerifyFileProtocolStandaloneWorkerFactory.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    Reflect.deleteProperty(document, 'execCommand');
    document.documentElement.removeAttribute('data-debug-file-protocol-standalone-lazy-style-initial-marker');
    document.querySelectorAll('[data-testid="standalone-lazy-style-test-style"]').forEach((element) => element.remove());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables active verification outside the standalone build', async () => {
    vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', false);
    const { wrapper } = await mountPage();
    const button = wrapper.get('[data-testid="run-standalone-verification-button"]');

    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    await flushPromises();

    expect(mocks.debugRunFileProtocolStandaloneVerification).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="standalone-verification-unavailable"]').text()).toContain('standalone');
  });

  it('runs verification with route, style, lazy import, and Worker probes', async () => {
    const { wrapper } = await mountPage();

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();

    expect(mocks.debugRunFileProtocolStandaloneVerification).toHaveBeenCalledOnce();
    const call = mocks.debugRunFileProtocolStandaloneVerification.mock.calls[0]?.[0] as {
      route: { fullPath: string, name: string | undefined, matchedPaths: string[], resolvedHref: string },
      tailwindStyleProbeElement: HTMLElement,
      scopedStyleProbeElement: HTMLElement,
      lazyStyleProbeElement: HTMLElement,
      lazyStyleInitialMarker: string,
      debugLoadFileProtocolStandaloneLazyStyleProbeModule: ({ signal }: { signal: AbortSignal }) => Promise<Readonly<{ marker: string }>>,
      debugExerciseFileProtocolStandaloneRouteRoundTrip: ({ signal }: { signal: AbortSignal }) => Promise<unknown>,
      debugRunWorkerProbe: ({ signal }: { signal: AbortSignal }) => Promise<unknown>,
    };
    expect(call.route).toMatchObject({
      fullPath: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      name: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      matchedPaths: [DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH],
      resolvedHref: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
    });
    expect(call.tailwindStyleProbeElement.dataset.testid).toBe('standalone-tailwind-probe');
    expect(call.scopedStyleProbeElement.dataset.testid).toBe('standalone-scoped-probe');
    expect(call.lazyStyleProbeElement.dataset.testid).toBe('standalone-lazy-style-probe');
    expect(call.lazyStyleInitialMarker).toBe('');
    await expect(call.debugRunWorkerProbe({ signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(mocks.debugVerifyFileProtocolStandaloneWorkerFactory).toHaveBeenCalledOnce();
    await expect(call.debugLoadFileProtocolStandaloneLazyStyleProbeModule({ signal: new AbortController().signal })).resolves.toEqual({
      marker: 'standalone-verification-lazy-style-probe-v1',
    });
    await expect(call.debugExerciseFileProtocolStandaloneRouteRoundTrip({ signal: new AbortController().signal })).resolves.toEqual({
      beforePath: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      transitionedPath: '/debug/standalone?__standalone-verification-route-probe=1',
      restoredPath: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
    });
    expect(wrapper.get('[data-testid="standalone-verification-status"]').text()).toContain('12 passed');
  });

  it('captures the lazy CSS marker independently of a 3px outline width', async () => {
    const { wrapper } = await mountPage();
    const lazyStyleProbeElement = wrapper.get('[data-testid="standalone-lazy-style-probe"]').element as HTMLElement;
    lazyStyleProbeElement.style.outlineWidth = '3px';

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();

    expect(getComputedStyle(lazyStyleProbeElement).outlineWidth).toBe('3px');
    expect(mocks.debugRunFileProtocolStandaloneVerification).toHaveBeenCalledOnce();
    expect(mocks.debugRunFileProtocolStandaloneVerification.mock.calls[0]?.[0]).toHaveProperty(
      'lazyStyleInitialMarker',
      '',
    );
  });

  it('shows Running while a verification is pending and restores the button afterward', async () => {
    const deferred = createDeferred<DebugFileProtocolStandaloneVerificationReport>();
    mocks.debugRunFileProtocolStandaloneVerification.mockReturnValueOnce(deferred.promise);
    const { wrapper } = await mountPage();
    const button = wrapper.get('[data-testid="run-standalone-verification-button"]');

    await button.trigger('click');

    expect(mocks.debugRunFileProtocolStandaloneVerification).toHaveBeenCalledOnce();
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('Running');
    deferred.resolve(createDebugVerificationReport());
    await flushPromises();
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.text()).not.toContain('Running');
  });

  it('ignores duplicate Run clicks while one verification is pending', async () => {
    const deferred = createDeferred<DebugFileProtocolStandaloneVerificationReport>();
    mocks.debugRunFileProtocolStandaloneVerification.mockReturnValueOnce(deferred.promise);
    const { wrapper } = await mountPage();
    const button = wrapper.get('[data-testid="run-standalone-verification-button"]');

    await button.trigger('click');
    await button.trigger('click');

    expect(mocks.debugRunFileProtocolStandaloneVerification).toHaveBeenCalledOnce();
    deferred.resolve(createDebugVerificationReport());
    await flushPromises();
  });

  it('reports an unexpected runner failure without retaining a stale report', async () => {
    const { wrapper } = await mountPage();
    const button = wrapper.get('[data-testid="run-standalone-verification-button"]');

    await button.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="standalone-verification-status"]').exists()).toBe(true);

    mocks.debugRunFileProtocolStandaloneVerification.mockRejectedValueOnce(new Error('synthetic runner failure'));
    await button.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="standalone-verification-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="standalone-verification-json"]').exists()).toBe(false);
    expect(button.attributes('disabled')).toBeUndefined();
    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification failed to run: synthetic runner failure',
      duration: 8000,
    });
  });

  it('can run again after completion and replaces the previous report', async () => {
    const { wrapper } = await mountPage();
    const button = wrapper.get('[data-testid="run-standalone-verification-button"]');

    await button.trigger('click');
    await flushPromises();
    mocks.debugRunFileProtocolStandaloneVerification.mockResolvedValueOnce(createDebugVerificationReport({ passed: 10, failed: 2 }));
    await button.trigger('click');
    await flushPromises();

    expect(mocks.debugRunFileProtocolStandaloneVerification).toHaveBeenCalledTimes(2);
    const firstInitialMarker = mocks.debugRunFileProtocolStandaloneVerification.mock.calls[0]?.[0]
      .lazyStyleInitialMarker as unknown;
    expect(firstInitialMarker).toBe('');
    expect(mocks.debugRunFileProtocolStandaloneVerification.mock.calls[1]?.[0]).toHaveProperty(
      'lazyStyleInitialMarker',
      firstInitialMarker,
    );
    expect(wrapper.get('[data-testid="standalone-verification-status"]').text()).toContain('10 passed / 2 failed');
  });

  it('preserves the first lazy-style observation across route remounts', async () => {
    const first = await mountPage();
    await first.wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();
    const firstInitialMarker = mocks.debugRunFileProtocolStandaloneVerification.mock.calls[0]?.[0]
      .lazyStyleInitialMarker as string;
    expect(firstInitialMarker).toBe('');
    first.wrapper.unmount();

    const style = document.createElement('style');
    style.dataset.testid = 'standalone-lazy-style-test-style';
    style.textContent = '.standalone-verification-lazy-style-probe { --debug-file-protocol-standalone-lazy-style-marker: applied; }';
    document.head.appendChild(style);

    const second = await mountPage();
    await second.wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();

    expect(mocks.debugRunFileProtocolStandaloneVerification).toHaveBeenCalledTimes(2);
    expect(mocks.debugRunFileProtocolStandaloneVerification.mock.calls[1]?.[0]).toHaveProperty(
      'lazyStyleInitialMarker',
      firstInitialMarker,
    );
  });

  it('changes an existing route probe value before restoring the original route', async () => {
    const { router, wrapper } = await mountPage();
    await router.replace({
      path: DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH,
      query: { '__standalone-verification-route-probe': '1' },
    });
    await flushPromises();

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();
    const call = mocks.debugRunFileProtocolStandaloneVerification.mock.calls[0]?.[0] as {
      debugExerciseFileProtocolStandaloneRouteRoundTrip: ({ signal }: { signal: AbortSignal }) => Promise<unknown>,
    };

    await expect(call.debugExerciseFileProtocolStandaloneRouteRoundTrip({ signal: new AbortController().signal })).resolves.toEqual({
      beforePath: '/debug/standalone?__standalone-verification-route-probe=1',
      transitionedPath: '/debug/standalone?__standalone-verification-route-probe=2',
      restoredPath: '/debug/standalone?__standalone-verification-route-probe=1',
    });
  });

  it('attempts to restore the original route when the probe transition fails', async () => {
    const { router, wrapper } = await mountPage();
    const replace = vi.spyOn(router, 'replace')
      .mockRejectedValueOnce(new Error('synthetic transition failure'))
      .mockResolvedValueOnce(undefined);

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();
    const call = mocks.debugRunFileProtocolStandaloneVerification.mock.calls[0]?.[0] as {
      debugExerciseFileProtocolStandaloneRouteRoundTrip: ({ signal }: { signal: AbortSignal }) => Promise<unknown>,
    };

    await expect(call.debugExerciseFileProtocolStandaloneRouteRoundTrip({ signal: new AbortController().signal })).rejects.toThrow('synthetic transition failure');
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenNthCalledWith(2, DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH);
  });

  it('copies report JSON through the Clipboard API when available', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const { wrapper } = await mountPage();

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledOnce();
    expect(execCommand).not.toHaveBeenCalled();
    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification JSON copied',
      duration: 4000,
    });
  });

  it('copies sanitized report JSON with the selection fallback', async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const { wrapper } = await mountPage();

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification JSON copied',
      duration: 4000,
    });
    expect(wrapper.get('[data-testid="standalone-verification-json"]').text()).toContain('<standalone-root>/index.html');
  });

  it('falls back to selection copy when the Clipboard API rejects file protocol access', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('clipboard denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const { wrapper } = await mountPage();

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Standalone verification JSON copied',
      duration: 4000,
    });
  });

  it('reports a copy failure when both clipboard methods are rejected', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('clipboard denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    const { wrapper } = await mountPage();

    await wrapper.get('[data-testid="run-standalone-verification-button"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="copy-standalone-verification-json-button"]').trigger('click');
    await flushPromises();

    expect(mocks.addToast).toHaveBeenCalledWith({
      message: 'Failed to copy standalone verification JSON: The browser rejected both clipboard methods.',
      duration: 8000,
    });
  });
});
