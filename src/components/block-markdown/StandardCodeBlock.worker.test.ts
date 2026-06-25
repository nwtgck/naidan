import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StandardCodeBlock from './StandardCodeBlock.vue';
import { createHighlightWorker } from '@/services/highlight/worker/impl';
import type { HighlightRequest, HighlightResponse } from '@/services/highlight/worker/types';

const highlightMock = vi.fn();

vi.mock('@/services/highlight/worker/client-shared', () => ({
  acquireSharedHighlightWorkerClient: vi.fn(async () => ({
    highlight: highlightMock,
    dispose: vi.fn(async () => undefined),
  })),
  releaseSharedHighlightWorkerClient: vi.fn(async () => undefined),
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders plain code first and replaces it with highlighted html after the worker resolves', async () => {
    highlightMock.mockReset();
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

    highlightMock.mockReset();
    highlightMock
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
    highlightMock.mockReset();
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
  });

  it('does not materialize hostile html during plain render or worker render', async () => {
    const worker = createHighlightWorker();
    const probe = vi.fn();
    vi.stubGlobal('__xssProbe', probe);
    const hostileCode = '<img src=x onerror="globalThis.__xssProbe?.(\'img-error\')"><svg onload="globalThis.__xssProbe?.(\'svg-load\')"></svg><a href="javascript:globalThis.__xssProbe?.(\'link-click\')">click</a><script>globalThis.__xssProbe?.(\'script-run\')</script>';

    highlightMock.mockReset();
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
