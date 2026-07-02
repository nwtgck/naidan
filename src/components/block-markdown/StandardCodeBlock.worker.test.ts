import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StandardCodeBlock from './StandardCodeBlock.vue';
import { createHighlightWorker } from '@/features/highlight/worker/impl';
import type { HighlightRequest, HighlightResponse } from '@/features/highlight/worker/types';
import type { SharedHighlightWorkerClientLease } from '@/features/highlight/worker/client-shared';

const {
  highlightMock,
  releaseLeaseMock,
  acquireLeaseMock,
} = vi.hoisted(() => ({
  highlightMock: vi.fn(),
  releaseLeaseMock: vi.fn(),
  acquireLeaseMock: vi.fn(),
}));

vi.mock('@/features/highlight/worker/client-shared', () => ({
  acquireSharedHighlightWorkerClientLease: acquireLeaseMock,
}));

function createDeferredHighlightResponse({
  response,
}: {
  response: HighlightResponse,
}): {
  promise: Promise<HighlightResponse>,
  resolve: () => void,
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<HighlightResponse>((resolve) => {
    resolvePromise = () => resolve(response);
  });

  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

describe('StandardCodeBlock worker integration', () => {
  beforeEach(() => {
    highlightMock.mockReset();
    releaseLeaseMock.mockReset();
    releaseLeaseMock.mockResolvedValue(undefined);
    acquireLeaseMock.mockReset();
    acquireLeaseMock.mockImplementation(async () => ({
      client: {
        highlight: highlightMock,
        dispose: vi.fn(async () => undefined),
      },
      release: releaseLeaseMock,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders plain code first and replaces it with highlighted html after the worker resolves', async () => {
    highlightMock.mockImplementationOnce(async () => ({
      html: '<span class="hljs-keyword">const</span> value = 1;',
      resolvedLanguage: 'javascript',
    }));

    const wrapper = mount(StandardCodeBlock, {
      props: {
        code: 'const value = 1;',
        lang: 'js',
      },
    });

    expect(wrapper.html()).toContain('const value = 1;');
    expect(wrapper.html()).not.toContain('hljs-keyword');

    await flushPromises();

    expect(wrapper.html()).toContain('hljs-keyword');
  });

  it('ignores stale highlight responses when code changes rapidly', async () => {
    const firstDeferred = createDeferredHighlightResponse({
      response: {
        html: '<span>first</span>',
        resolvedLanguage: 'javascript',
      },
    });
    const secondDeferred = createDeferredHighlightResponse({
      response: {
        html: '<span>second</span>',
        resolvedLanguage: 'javascript',
      },
    });

    highlightMock
      .mockResolvedValueOnce({
        html: '<span>initial</span>',
        resolvedLanguage: 'javascript',
      })
      .mockImplementationOnce(async ({ request }: { request: HighlightRequest }) => {
        expect(request.code).toContain('first');
        return firstDeferred.promise;
      })
      .mockImplementationOnce(async ({ request }: { request: HighlightRequest }) => {
        expect(request.code).toContain('second');
        return secondDeferred.promise;
      });

    const wrapper = mount(StandardCodeBlock, {
      props: {
        code: 'const initial = true;',
        lang: 'js',
      },
    });
    await flushPromises();

    await wrapper.setProps({
      code: 'const first = true;',
      lang: 'js',
    });
    await wrapper.setProps({
      code: 'const second = true;',
      lang: 'js',
    });

    secondDeferred.resolve();
    await flushPromises();
    expect(wrapper.html()).toContain('second');

    firstDeferred.resolve();
    await flushPromises();
    expect(wrapper.html()).toContain('second');
    expect(wrapper.html()).not.toContain('first');
  });

  it('keeps plain code visible when the worker highlight fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    highlightMock.mockRejectedValueOnce(new Error('worker unavailable'));

    const wrapper = mount(StandardCodeBlock, {
      props: {
        code: 'const fallback = true;',
        lang: 'js',
      },
    });

    await flushPromises();

    expect(wrapper.html()).toContain('const fallback = true;');
    expect(wrapper.html()).not.toContain('hljs');
    expect(consoleError).toHaveBeenCalledWith('Failed to highlight code in worker:', expect.any(Error));
  });


  it('retries client acquisition after a transient creation failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    acquireLeaseMock
      .mockRejectedValueOnce(new Error('worker startup failed'))
      .mockResolvedValueOnce({
        client: {
          highlight: highlightMock,
          dispose: vi.fn(async () => undefined),
        },
        release: releaseLeaseMock,
      });
    highlightMock.mockResolvedValueOnce({
      html: '<span class="hljs-keyword">const</span> recovered = true;',
      resolvedLanguage: 'javascript',
    });

    const wrapper = mount(StandardCodeBlock, {
      props: {
        code: 'const initial = true;',
        lang: 'js',
      },
    });
    await flushPromises();

    await wrapper.setProps({
      code: 'const recovered = true;',
      lang: 'js',
    });
    await flushPromises();

    expect(acquireLeaseMock).toHaveBeenCalledTimes(2);
    expect(wrapper.html()).toContain('hljs-keyword');
    consoleError.mockRestore();
  });


  it('releases a pending lease when the component unmounts before acquisition completes', async () => {
    let resolveLease: ((lease: SharedHighlightWorkerClientLease) => void) | undefined;
    const leasePromise = new Promise<SharedHighlightWorkerClientLease>((resolve) => {
      resolveLease = resolve;
    });
    acquireLeaseMock.mockReturnValueOnce(leasePromise);

    const wrapper = mount(StandardCodeBlock, {
      props: {
        code: 'const pending = true;',
        lang: 'js',
      },
    });
    wrapper.unmount();

    resolveLease?.({
      client: {
        highlight: highlightMock,
        dispose: vi.fn(async () => undefined),
      },
      release: releaseLeaseMock,
    });
    await flushPromises();

    expect(highlightMock).not.toHaveBeenCalled();
    expect(releaseLeaseMock).toHaveBeenCalledOnce();
  });

  it('does not materialize hostile html during plain render or worker render', async () => {
    const worker = createHighlightWorker();
    const probe = vi.fn();
    vi.stubGlobal('__xssProbe', probe);
    const hostileCode = '<img src=x onerror="globalThis.__xssProbe?.(\'img-error\')"><svg onload="globalThis.__xssProbe?.(\'svg-load\')"></svg><a href="javascript:globalThis.__xssProbe?.(\'link-click\')">click</a><script>globalThis.__xssProbe?.(\'script-run\')</script>';

    highlightMock.mockImplementationOnce(async ({ request }: { request: HighlightRequest }) => {
      return await worker.highlight({ request });
    });

    const wrapper = mount(StandardCodeBlock, {
      props: {
        code: hostileCode,
        lang: 'html',
      },
    });

    const plainCodeElement = wrapper.find('pre code').element as HTMLElement;
    expect(plainCodeElement.querySelector('img')).toBeNull();
    expect(plainCodeElement.querySelector('svg')).toBeNull();
    expect(plainCodeElement.querySelector('a')).toBeNull();
    expect(plainCodeElement.querySelector('script')).toBeNull();
    expect(probe).not.toHaveBeenCalled();

    await flushPromises();

    const highlightedCodeElement = wrapper.find('pre code').element as HTMLElement;
    expect(highlightedCodeElement.querySelector('img')).toBeNull();
    expect(highlightedCodeElement.querySelector('svg')).toBeNull();
    expect(highlightedCodeElement.querySelector('a')).toBeNull();
    expect(highlightedCodeElement.querySelector('script')).toBeNull();
    highlightedCodeElement.dispatchEvent(new Event('error'));
    highlightedCodeElement.dispatchEvent(new Event('load'));
    expect(probe).not.toHaveBeenCalled();
  });
});
