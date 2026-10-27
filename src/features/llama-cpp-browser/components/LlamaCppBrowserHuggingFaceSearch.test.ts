import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { searchModels } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';

vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), searchModels: vi.fn() }));

function render() {
  const wrapper = mount(LlamaCppBrowserHuggingFaceSearch, { props: { disabled: false, repositoryInput: '', scrollOwner: 'results' } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

async function submit({ wrapper, query }: { wrapper: VueWrapper, query: string }): Promise<void> {
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue(query);
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(searchModels).mockResolvedValue({ results: [], nextCursor: undefined });
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('explicit Hugging Face model search', () => {
  it('prepares a disabled search view without searching when mounted, revealed, or focused', async () => {
    const wrapper = mount(LlamaCppBrowserHuggingFaceSearch, { props: { disabled: true, repositoryInput: '', scrollOwner: 'results' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    await wrapper.get('[data-testid="llama-hf-search-query"]').trigger('keydown', { key: 'Enter' });
    expect(searchModels).not.toHaveBeenCalled();
    await wrapper.setProps({ disabled: false });
    await wrapper.get('[data-testid="llama-hf-search-query"]').trigger('focus');
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(searchModels).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it('does not search on mount, focus, typing, clearing, or remounting', async () => {
    {
      using view = render();
      const query = view.wrapper.get('[data-testid="llama-hf-search-query"]');
      await query.trigger('focus');
      await query.setValue('qwen');
      await query.setValue('');
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
      expect(view.wrapper.find('[data-testid="llama-hf-search-results"]').exists()).toBe(false);
    }
    using reopened = render();
    await flushPromises();
    expect(reopened.wrapper.get('[data-testid="llama-hf-search-submit"]').text()).toContain('Show trending models');
    expect(searchModels).not.toHaveBeenCalled();
  });

  it('searches once on explicit submit and renders only API text and optional statistics', async () => {
    vi.mocked(searchModels).mockResolvedValue({ results: [{ id: 'Qwen/Qwen-GGUF', downloads: 1234, likes: 56 }, { id: 'other/model' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    expect(searchModels).toHaveBeenCalledExactlyOnceWith({ query: 'qwen', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });
    const results = view.wrapper.findAll('[data-testid="llama-hf-search-result"]');
    expect(results).toHaveLength(2);
    expect(results[0]!.text()).toContain('Qwen/Qwen-GGUF');
    expect(results[0]!.text()).toContain('Downloads:');
    expect(results[0]!.text()).toContain('Likes:');
    expect(results[1]!.text()).not.toContain('Downloads:');
    expect(view.wrapper.find('img').exists()).toBe(false);
    expect(view.wrapper.emitted('select')).toBeUndefined();
    expect(view.wrapper.emitted('busy')).toEqual([[false], [true], [false]]);
  });

  it('keeps a bounded list when its caller assigns scrolling to search results', async () => {
    vi.mocked(searchModels).mockResolvedValue({ results: [{ id: 'owner/model' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    const list = view.wrapper.get('[data-testid="llama-hf-search-results"]');
    expect(list.classes()).toContain('overflow-y-auto');
    expect(list.classes()).toContain('max-h-64');
    expect(view.wrapper.get('[data-testid="llama-hf-search-controls"]').classes()).not.toContain('sticky');
  });

  it('keeps expandable guidance outside the sticky controls without replacing the search input', async () => {
    const wrapper = mount(LlamaCppBrowserHuggingFaceSearch, {
      props: { disabled: false, repositoryInput: '', scrollOwner: 'parent' },
      global: { stubs: { CspMessageHint: { template: '<details data-testid="search-guidance"><summary>Connection guidance</summary><button>Export data</button></details>' } } },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const query = wrapper.get('[data-testid="llama-hf-search-query"]');
    await query.setValue('qwen');
    const guidance = wrapper.get('[data-testid="search-guidance"]');
    expect(guidance.element.closest('[data-testid="llama-hf-search-controls"]')).toBeNull();
    expect(guidance.element.parentElement).toBe(wrapper.element);
    guidance.element.setAttribute('open', '');
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-search-query"]').element).toBe(query.element);
    expect((query.element as HTMLInputElement).value).toBe('qwen');
    expect(searchModels).not.toHaveBeenCalled();
  });

  it('searches with Enter and ignores composition confirmation', async () => {
    using view = render();
    const query = view.wrapper.get('[data-testid="llama-hf-search-query"]');
    await query.setValue('qwen');
    await query.trigger('keydown', { key: 'Enter', isComposing: true });
    expect(searchModels).not.toHaveBeenCalled();
    await query.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it.each(['keyCode', 'which'] as const)('does not treat an IME %s 229 Enter as a search request', async property => {
    using view = render();
    const query = view.wrapper.get('[data-testid="llama-hf-search-query"]');
    await query.setValue('qwen');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(event, property, { value: 229 });
    query.element.dispatchEvent(event);
    await flushPromises();
    expect(searchModels).not.toHaveBeenCalled();
    await query.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it('requests trending models only when the empty search is explicitly submitted', async () => {
    using view = render();
    await submit({ wrapper: view.wrapper, query: '   ' });
    expect(searchModels).toHaveBeenCalledExactlyOnceWith({ query: '   ', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });
    expect(view.wrapper.get('[data-testid="llama-hf-search-empty"]').text()).toBe('No models found.');
  });

  it('keeps the completed trending list identified while a keyword is drafted', async () => {
    vi.mocked(searchModels).mockResolvedValue({ results: [{ id: 'owner/trending' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: '' });
    await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    expect(view.wrapper.find('[data-testid="llama-hf-search-result-query"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toBe('owner/trending');
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it('keeps completed results selectable while editing the next query and after selection', async () => {
    vi.mocked(searchModels).mockResolvedValue({ results: [{ id: 'Qwen/Qwen-GGUF', likes: 0 }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('gemma');
    expect(view.wrapper.get('[data-testid="llama-hf-search-result-query"]').text()).toBe('Results for “qwen”');
    expect(searchModels).toHaveBeenCalledOnce();
    await view.wrapper.get('[data-testid="llama-hf-search-result"]').trigger('click');
    expect(view.wrapper.emitted('select')).toEqual([['Qwen/Qwen-GGUF']]);
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toContain('Qwen/Qwen-GGUF');
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it('keeps submission singular while pending and cancels explicitly without retrying', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockReturnValue(pending.promise);
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    const signal = vi.mocked(searchModels).mock.calls[0]![0].signal;
    expect(view.wrapper.get('[data-testid="llama-hf-search-submit"]').attributes('disabled')).toBeDefined();
    expect(view.wrapper.get('[data-testid="llama-hf-search-query"]').attributes('disabled')).toBeUndefined();
    await view.wrapper.get('[data-testid="llama-hf-search-cancel"]').trigger('click');
    expect(signal.aborted).toBe(true);
    pending.resolve({ results: [{ id: 'old/model' }], nextCursor: undefined });
    await flushPromises();
    expect(view.wrapper.find('[data-testid="llama-hf-search-results"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="llama-hf-search-error"]').exists()).toBe(false);
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it.each(['success', 'failure'] as const)('ignores a stale %s and finally while the newer search is pending', async outcome => {
    const first = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    const second = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    const oldSignal = vi.mocked(searchModels).mock.calls[0]![0].signal;
    await submit({ wrapper: view.wrapper, query: 'gemma' });
    expect(oldSignal.aborted).toBe(true);
    if (outcome === 'success') {
      first.resolve({ results: [{ id: 'old/model' }], nextCursor: undefined });
    } else {
      first.reject(new Error('late failure'));
    }
    await flushPromises();
    expect(view.wrapper.attributes('aria-busy')).toBe('true');
    expect(view.wrapper.find('[data-testid="llama-hf-search-results"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="llama-hf-search-error"]').exists()).toBe(false);
    expect(view.wrapper.emitted('busy')).toEqual([[false], [true], [false], [true]]);
    second.resolve({ results: [{ id: 'google/gemma-GGUF' }], nextCursor: undefined });
    await flushPromises();
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toContain('google/gemma-GGUF');
    expect(view.wrapper.attributes('aria-busy')).toBe('false');
  });

  it('retains a successful list when the query is cleared or the direct repository input changes', async () => {
    vi.mocked(searchModels).mockResolvedValue({ results: [{ id: 'owner/model' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'model' });
    await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('');
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toContain('owner/model');
    expect(view.wrapper.get('[data-testid="llama-hf-search-result-query"]').text()).toBe('Results for “model”');
    await view.wrapper.setProps({ repositoryInput: 'other/repository' });
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toContain('owner/model');
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it.each(['repository', 'disabled', 'unmount'] as const)('aborts pending results on %s and ignores completion', async change => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockReturnValue(pending.promise);
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'model' });
    const signal = vi.mocked(searchModels).mock.calls[0]![0].signal;
    switch (change) {
    case 'repository': await view.wrapper.setProps({ repositoryInput: 'other/repo' });
      break;
    case 'disabled': await view.wrapper.setProps({ disabled: true });
      break;
    case 'unmount': view.wrapper.unmount();
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    expect(signal.aborted).toBe(true);
    pending.resolve({ results: [{ id: 'old/model' }], nextCursor: undefined });
    await flushPromises();
    expect(view.wrapper.emitted('select')).toBeUndefined();
    if (change !== 'unmount') {
      expect(view.wrapper.find('[data-testid="llama-hf-search-results"]').exists()).toBe(false);
    }
  });

  it('does not submit while disabled and does not auto-search when enabled', async () => {
    using view = render();
    await view.wrapper.setProps({ disabled: true });
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await view.wrapper.setProps({ disabled: false });
    await flushPromises();
    expect(searchModels).not.toHaveBeenCalled();
  });

  it('shows a failure and retries only after another explicit submit', async () => {
    vi.mocked(searchModels).mockRejectedValueOnce(new Error('private transport details')).mockResolvedValueOnce({ results: [{ id: 'owner/retry' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'retry' });
    expect(view.wrapper.get('[data-testid="llama-hf-search-error"]').text()).toBe('Could not search models. Try again.');
    expect(view.wrapper.text()).not.toContain('private transport details');
    expect(searchModels).toHaveBeenCalledOnce();
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(searchModels).toHaveBeenCalledTimes(2);
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toContain('owner/retry');
  });

  it('shows optional metadata with GGUF parameter totals preferred and safetensors totals as a fallback', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({
      results: [
        { id: 'owner/gguf', pipeline_tag: 'text-generation', gguf: { total: 7_000_000_000, architecture: 'llama' }, safetensors: { total: 8_000_000_000 }, lastModified: '2026-08-20T12:34:56.000Z' },
        { id: 'owner/fallback', pipeline_tag: 'future-task', gguf: { architecture: 'qwen' }, safetensors: { total: 235_100_000_000 } },
        { id: 'owner/minimal' },
      ],
      nextCursor: undefined,
    });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'model' });
    const rows = view.wrapper.findAll('[data-testid="llama-hf-search-result"]');
    expect(rows[0]!.get('[data-testid="llama-hf-search-result-task"]').text()).toContain('text-generation');
    expect(rows[0]!.get('[data-testid="llama-hf-search-result-parameters"]').text()).toContain('7B');
    expect(rows[0]!.get('[data-testid="llama-hf-search-result-architecture"]').text()).toContain('llama');
    expect(rows[0]!.get('[data-testid="llama-hf-search-result-updated"]').attributes('datetime')).toBe('2026-08-20T12:34:56.000Z');
    expect(rows[0]!.get('[data-testid="llama-hf-search-result-updated"]').attributes('title')).toBeTruthy();
    expect(rows[0]!.get('[data-testid="llama-hf-search-result-updated"]').text()).toContain('Updated');
    expect(rows[1]!.get('[data-testid="llama-hf-search-result-parameters"]').text()).toContain('235.1B');
    expect(rows[1]!.get('[data-testid="llama-hf-search-result-task"]').text()).toContain('future-task');
    expect(rows[2]!.text()).toBe('owner/minimal');
    await rows[2]!.trigger('click');
    expect(view.wrapper.emitted('select')).toEqual([['owner/minimal']]);
  });

  it('preserves a long repository ID for its accessible name, tooltip, and selection', async () => {
    const repository = `owner/${'long-model-name-'.repeat(12)}GGUF`;
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: repository }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'long' });
    const row = view.wrapper.get('[data-testid="llama-hf-search-result"]');
    expect(row.text()).toBe(repository);
    expect(row.get('[title]').attributes('title')).toBe(repository);
    await row.trigger('click');
    expect(view.wrapper.emitted('select')).toEqual([[repository]]);
  });

  it('appends pages only after Show more and retains the committed search while the draft changes', async () => {
    const firstResults = Array.from({ length: 20 }, (_value, index) => ({ id: `owner/model-${index}` }));
    vi.mocked(searchModels).mockResolvedValueOnce({ results: firstResults, nextCursor: 'cursor-a' }).mockResolvedValueOnce({ results: [{ id: 'owner/model-0' }, { id: 'owner/new' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    expect(searchModels).toHaveBeenCalledOnce();
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(20);
    await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('gemma');
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[1]?.[0]).toEqual({ query: 'qwen', cursor: 'cursor-a', numParameters: undefined, signal: expect.any(AbortSignal) });
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(21);
    expect(view.wrapper.get('[data-testid="llama-hf-search-result-query"]').text()).toBe('Results for “qwen”');
    expect(view.wrapper.find('[data-testid="llama-hf-search-more"]').exists()).toBe(false);
  });

  it('preserves a trend query while paging after a keyword is drafted and stops cursor cycles', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'cursor-a' }).mockResolvedValueOnce({ results: [{ id: 'owner/second' }], nextCursor: 'cursor-b' }).mockResolvedValueOnce({ results: [{ id: 'owner/third' }], nextCursor: 'cursor-a' });
    using view = render();
    await submit({ wrapper: view.wrapper, query: '' });
    await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[1]?.[0].query).toBe('');
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[2]?.[0].query).toBe('');
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(3);
    expect(view.wrapper.find('[data-testid="llama-hf-search-more"]').exists()).toBe(false);
  });

  it('keeps completed rows on a more failure and retries the same cursor only on another click', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'cursor-a' }).mockRejectedValueOnce(new Error('private URL')).mockResolvedValueOnce({ results: [{ id: 'owner/retried' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toBe('owner/first');
    expect(view.wrapper.get('[data-testid="llama-hf-search-more-error"]').text()).not.toContain('private URL');
    expect(view.wrapper.get('[data-testid="llama-hf-search-more"]').text()).toBe('Retry');
    expect(view.wrapper.get<HTMLButtonElement>('[data-testid="llama-hf-search-more"]').element.disabled).toBe(false);
    expect(searchModels).toHaveBeenCalledTimes(2);
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[2]?.[0].cursor).toBe('cursor-a');
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(2);
    expect(view.wrapper.find('[data-testid="llama-hf-search-more-error"]').exists()).toBe(false);
  });

  it.each(['success', 'failure'] as const)('keeps the list when typing aborts more and ignores the old %s/finally', async outcome => {
    const firstMore = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    const retryMore = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'cursor-a' }).mockReturnValueOnce(firstMore.promise).mockReturnValueOnce(retryMore.promise);
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    const oldSignal = vi.mocked(searchModels).mock.calls[1]![0].signal;
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').attributes('disabled')).toBeDefined();
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    expect(searchModels).toHaveBeenCalledTimes(2);
    await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('gemma');
    expect(oldSignal.aborted).toBe(true);
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toBe('owner/first');
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    if (outcome === 'success') {
      firstMore.resolve({ results: [{ id: 'old/model' }], nextCursor: undefined });
    } else {
      firstMore.reject(new Error('late more failure'));
    }
    await flushPromises();
    expect(view.wrapper.attributes('aria-busy')).toBe('true');
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(1);
    retryMore.resolve({ results: [{ id: 'owner/second' }], nextCursor: undefined });
    await flushPromises();
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(2);
    expect(view.wrapper.text()).not.toContain('old/model');
  });

  it.each(['new-search', 'disabled', 'unmount'] as const)('prevents a late page append after %s', async change => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'cursor-a' }).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ results: [{ id: 'owner/replacement' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    const signal = vi.mocked(searchModels).mock.calls[1]![0].signal;
    switch (change) {
    case 'new-search': await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
      break;
    case 'disabled': await view.wrapper.setProps({ disabled: true });
      break;
    case 'unmount': view.wrapper.unmount();
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    expect(signal.aborted).toBe(true);
    pending.resolve({ results: [{ id: 'old/page' }], nextCursor: undefined });
    await flushPromises();
    if (change !== 'unmount') {
      expect(view.wrapper.text()).not.toContain('old/page');
    }
    if (change === 'new-search') {
      expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toBe('owner/replacement');
    }
  });

  it('marks only the newest appended batch and retains its marker for duplicate pages, failures, and draft edits', async () => {
    vi.mocked(searchModels)
      .mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'a' })
      .mockResolvedValueOnce({ results: [{ id: 'owner/first' }, { id: 'owner/new-a' }], nextCursor: 'b' })
      .mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'c' })
      .mockResolvedValueOnce({ results: [{ id: 'owner/new-b' }], nextCursor: 'd' })
      .mockRejectedValueOnce(new Error('more failed'))
      .mockResolvedValueOnce({ results: [{ id: 'owner/replacement' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    expect(view.wrapper.find('[data-testid="llama-hf-search-new-results"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="llama-hf-search-new-results"]').element.parentElement?.querySelector('button')?.textContent).toBe('owner/new-a');
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]').some(row => row.text().includes('New results start here'))).toBe(false);
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="llama-hf-search-new-results"]').element.parentElement?.querySelector('button')?.textContent).toBe('owner/new-a');
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-new-results"]')).toHaveLength(1);
    expect(view.wrapper.get('[data-testid="llama-hf-search-new-results"]').element.parentElement?.querySelector('button')?.textContent).toBe('owner/new-b');
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('gemma');
    expect(view.wrapper.get('[data-testid="llama-hf-search-new-results"]').element.parentElement?.querySelector('button')?.textContent).toBe('owner/new-b');
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.find('[data-testid="llama-hf-search-new-results"]').exists()).toBe(false);
  });

  it('keeps filters closed by default and does not fetch when opening, editing, or closing them', async () => {
    using view = render();
    expect(view.wrapper.find('[data-testid="llama-hf-search-minimum"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    await view.wrapper.get('[data-testid="llama-hf-search-minimum"]').setValue('6');
    await view.wrapper.get('[data-testid="llama-hf-search-maximum"]').setValue('128');
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    expect(view.wrapper.find('[data-testid="llama-hf-search-minimum"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').text()).toContain('6–128B');
    expect(searchModels).not.toHaveBeenCalled();
  });

  it('keeps the committed parameter range for more results while the draft range changes', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'next' }).mockResolvedValueOnce({ results: [{ id: 'owner/second' }], nextCursor: undefined });
    using view = render();
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    await view.wrapper.get('[data-testid="llama-hf-search-minimum"]').setValue('6');
    await view.wrapper.get('[data-testid="llama-hf-search-maximum"]').setValue('8');
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    expect(vi.mocked(searchModels).mock.calls[0]?.[0].numParameters).toBe('min:6B,max:8B');
    await view.wrapper.get('[data-testid="llama-hf-search-minimum"]').setValue('9');
    await view.wrapper.get('[data-testid="llama-hf-search-maximum"]').setValue('10');
    expect(view.wrapper.get('[data-testid="llama-hf-search-result-query"]').text()).toContain('6–8B');
    expect(view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').text()).toContain('9–10B');
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[1]?.[0].numParameters).toBe('min:6B,max:8B');
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(2);
  });

  it.each([
    ['9', '1'], ['NaN', ''], ['Infinity', ''], ['-1', ''], ['.', ''], ['1e-8', ''], ['1e308', ''],
  ])('rejects invalid parameter drafts %s / %s without fetching', async (minimum, maximum) => {
    using view = render();
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    await view.wrapper.get('[data-testid="llama-hf-search-minimum"]').setValue(minimum);
    await view.wrapper.get('[data-testid="llama-hf-search-maximum"]').setValue(maximum);
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    expect(view.wrapper.find('[data-testid="llama-hf-search-filter-error"]').exists()).toBe(true);
    expect(searchModels).not.toHaveBeenCalled();
  });

  it('cancels a pending page when a filter draft changes while keeping the completed list and cursor', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'next' }).mockReturnValueOnce(pending.promise);
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    await view.wrapper.get('[data-testid="llama-hf-search-minimum"]').setValue('6');
    expect(vi.mocked(searchModels).mock.calls[1]?.[0].signal.aborted).toBe(true);
    pending.resolve({ results: [{ id: 'old/page' }], nextCursor: undefined });
    await flushPromises();
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toBe('owner/first');
    expect(view.wrapper.find('[data-testid="llama-hf-search-more"]').exists()).toBe(true);
  });

  it('retains completed results, paging, and the marker across selection and external busy states', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'a' }).mockResolvedValueOnce({ results: [{ id: 'owner/second' }], nextCursor: 'b' });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
    await flushPromises();
    await view.wrapper.findAll('[data-testid="llama-hf-search-result"]')[0]!.trigger('click');
    await view.wrapper.setProps({ repositoryInput: 'owner/first', disabled: true });
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(2);
    expect(view.wrapper.find('[data-testid="llama-hf-search-new-results"]').exists()).toBe(true);
    await view.wrapper.setProps({ disabled: false });
    await view.wrapper.findAll('[data-testid="llama-hf-search-result"]')[1]!.trigger('click');
    expect(view.wrapper.emitted('select')).toEqual([['owner/first'], ['owner/second']]);
    expect(view.wrapper.find('[data-testid="llama-hf-search-more"]').exists()).toBe(true);
    expect(searchModels).toHaveBeenCalledTimes(2);
  });

  it.each([
    { index: 0, minimum: '', maximum: '1', filter: 'max:1B' },
    { index: 1, minimum: '1', maximum: '4', filter: 'min:1B,max:4B' },
    { index: 2, minimum: '4', maximum: '8', filter: 'min:4B,max:8B' },
    { index: 3, minimum: '8', maximum: '16', filter: 'min:8B,max:16B' },
    { index: 4, minimum: '16', maximum: '32', filter: 'min:16B,max:32B' },
    { index: 5, minimum: '32', maximum: '70', filter: 'min:32B,max:70B' },
    { index: 6, minimum: '70', maximum: '128', filter: 'min:70B,max:128B' },
    { index: 7, minimum: '128', maximum: '', filter: 'min:128B' },
  ])('applies parameter preset $index to the draft without fetching until Search', async ({ index, minimum, maximum, filter }) => {
    using view = render();
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    const presets = view.wrapper.findAll('[data-testid="llama-hf-search-preset"]');
    expect(presets).toHaveLength(8);
    await presets[index]!.trigger('click');
    expect(view.wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-minimum"]').element.value).toBe(minimum);
    expect(view.wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-maximum"]').element.value).toBe(maximum);
    expect(presets.filter(preset => preset.attributes('aria-pressed') === 'true')).toHaveLength(1);
    expect(presets[index]!.attributes('aria-pressed')).toBe('true');
    expect(searchModels).not.toHaveBeenCalled();
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[0]?.[0].numParameters).toBe(filter);
  });

  it('keeps a completed list while presets are selected and allows fine tuning before searching', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'next' });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    await view.wrapper.findAll('[data-testid="llama-hf-search-preset"]')[1]!.trigger('click');
    await view.wrapper.get('[data-testid="llama-hf-search-minimum"]').setValue('1.5');
    expect(view.wrapper.findAll('[data-testid="llama-hf-search-preset"]').every(preset => preset.attributes('aria-pressed') === 'false')).toBe(true);
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toBe('owner/first');
    expect(view.wrapper.get('[data-testid="llama-hf-search-minimum"]').attributes('aria-label')).toBe('Minimum parameters (B)');
    expect(view.wrapper.get('[data-testid="llama-hf-search-minimum"]').attributes('placeholder')).toBe('No minimum');
    expect(searchModels).toHaveBeenCalledOnce();
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[1]?.[0].numParameters).toBe('min:1.5B,max:4B');
  });

  it('opens a repository with a separate external anchor without selecting or checking it', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'Qwen/Qwen-GGUF' }], nextCursor: undefined });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    const link = view.wrapper.get('[data-testid="llama-hf-search-repository-link"]');
    expect(link.attributes('href')).toBe('https://huggingface.co/Qwen/Qwen-GGUF');
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    expect(link.attributes('aria-label')).toContain('Qwen/Qwen-GGUF');
    expect(link.attributes('title')).toContain('Qwen/Qwen-GGUF');
    expect(link.element.closest('button')).toBeNull();
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').find('a').exists()).toBe(false);
    await link.trigger('click');
    expect(view.wrapper.emitted('select')).toBeUndefined();
    expect(searchModels).toHaveBeenCalledOnce();
  });

  it('clears draft bounds without clearing results and does not treat invalid input as No limit', async () => {
    vi.mocked(searchModels).mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'next' });
    using view = render();
    await submit({ wrapper: view.wrapper, query: 'qwen' });
    await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
    const clear = view.wrapper.get('[data-testid="llama-hf-search-clear-parameters"]');
    expect(clear.attributes('aria-pressed')).toBe('true');
    await view.wrapper.findAll('[data-testid="llama-hf-search-preset"]')[6]!.trigger('click');
    expect(clear.attributes('aria-pressed')).toBe('false');
    await view.wrapper.get('[data-testid="llama-hf-search-minimum"]').setValue('invalid');
    expect(clear.attributes('aria-pressed')).toBe('false');
    await clear.trigger('click');
    expect(view.wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-minimum"]').element.value).toBe('');
    expect(view.wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-maximum"]').element.value).toBe('');
    expect(clear.attributes('aria-pressed')).toBe('true');
    expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').text()).toBe('owner/first');
    expect(searchModels).toHaveBeenCalledOnce();
    await view.wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(searchModels).mock.calls[1]?.[0].numParameters).toBeUndefined();
  });
});
