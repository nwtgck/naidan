import { beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { provideModelSelectorHuggingFaceSearchState } from '@/composables/useModelSelectorHuggingFaceSearchState';
import type { ModelSearchPage, searchGgufModels } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ModelSelectorHuggingFaceSearch from './ModelSelectorHuggingFaceSearch.vue';

const search = vi.hoisted(() => vi.fn<typeof searchGgufModels>());
const autoSearch = ref(false);
vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', () => ({ searchGgufModels: search }));
vi.mock('@/composables/useHuggingFaceModelSearchPreferences', () => ({
  useHuggingFaceModelSearchPreferences: () => ({
    autoSearch,
    saving: ref(false),
    saveFailed: ref(false),
    async setAutoSearch({ enabled }: { enabled: boolean }) {
      autoSearch.value = enabled;
    },
  }),
}));

beforeEach(async () => {
  autoSearch.value = false;
  search.mockReset().mockResolvedValue({ results: [], nextCursor: undefined });
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture() {
  const wrapper = mount(ModelSelectorHuggingFaceSearch, { props: { query: 'qwen', active: true, disabled: false }, slots: { repository: () => h('div', { 'data-testid': 'repository-details' }) } });
  return {
    wrapper,
    [Symbol.dispose]() {
      if (wrapper.exists()) {
        wrapper.unmount();
      }
    },
  };
}

it('only emits edits and never searches on mount, query changes or activation', async () => {
  using view = fixture();
  await view.wrapper.get('[data-testid="model-selector-hf-query"]').setValue('another query');
  expect(view.wrapper.emitted('update:query')).toEqual([['another query']]);
  await view.wrapper.setProps({ query: 'another query', active: false });
  await view.wrapper.setProps({ active: true });
  expect(search).not.toHaveBeenCalled();
});

it('retains query, filters, pages and the latest page boundary until its owning selector unmounts', async () => {
  search
    .mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'next' })
    .mockResolvedValueOnce({ results: [{ id: 'owner/first' }, { id: 'owner/new' }], nextCursor: 'last' });
  const open = ref(true);
  const Selector = defineComponent({
    setup() {
      const { query } = provideModelSelectorHuggingFaceSearchState();
      return () => open.value ? h(ModelSelectorHuggingFaceSearch, {
        query: query.value,
        active: true,
        disabled: false,
        'onUpdate:query': value => {
          query.value = value;
        },
      }) : undefined;
    },
  });
  const original = mount(Selector);
  using originalCleanup = { [Symbol.dispose]: () => original.unmount() };
  const query = '[data-testid="model-selector-hf-query"]';
  const minimum = '[data-testid="llama-hf-search-minimum"]';
  const marker = '[data-testid="model-selector-hf-new-results"]';
  await original.get(query).setValue('qwen');
  await original.get('[data-testid="model-selector-hf-filter"]').trigger('click');
  await original.get(minimum).setValue('6');
  await original.get('form').trigger('submit');
  await flushPromises();
  expect(original.find(marker).exists()).toBe(false);
  await original.get('[data-testid="model-selector-hf-more"]').trigger('click');
  await flushPromises();
  expect(original.get(marker).element.closest('li')?.querySelector('[data-repository]')?.getAttribute('data-repository')).toBe('owner/new');

  open.value = false;
  await nextTick();
  autoSearch.value = true;
  open.value = true;
  await nextTick();
  expect(original.get<HTMLInputElement>(query).element.value).toBe('qwen');
  expect(original.get(marker).element.closest('li')?.textContent).toContain('owner/new');
  expect(original.find('[data-testid="model-selector-hf-more"]').exists()).toBe(true);
  await original.get('[data-testid="model-selector-hf-filter"]').trigger('click');
  expect(original.get<HTMLInputElement>(minimum).element.value).toBe('6');
  expect(search).toHaveBeenCalledTimes(2);

  const separate = mount(Selector);
  using separateCleanup = { [Symbol.dispose]: () => separate.unmount() };
  expect(separate.get<HTMLInputElement>(query).element.value).toBe('');
  expect(separate.find(marker).exists()).toBe(false);
  expect(separate.find('[data-repository="owner/first"]').exists()).toBe(false);
  void originalCleanup;
  void separateCleanup;
});

it('searches only after an explicit submit or non-IME Enter', async () => {
  using view = fixture();
  const input = view.wrapper.get('[data-testid="model-selector-hf-query"]');
  await input.trigger('keydown', { key: 'Enter', isComposing: true });
  await input.trigger('keydown', { key: 'Enter', keyCode: 229 });
  expect(search).not.toHaveBeenCalled();
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'qwen', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });
  await view.wrapper.get('form').trigger('submit');
  expect(search).toHaveBeenCalledTimes(2);
});

it('keeps the submit button and its fixed width across trending, search and repository modes', async () => {
  using view = fixture();
  await view.wrapper.setProps({ query: '' });
  const button = view.wrapper.get<HTMLButtonElement>('[data-testid="model-selector-hf-submit"]');
  expect(button.text()).toBe('Trending');
  expect(button.element.style.inlineSize).toBe('6rem');
  expect(search).not.toHaveBeenCalled();
  await view.wrapper.get('form').trigger('submit');
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: '', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });

  for (const [query, label] of [['qwen', 'Search'], ['https://huggingface.co/owner/model', 'Open']]) {
    await view.wrapper.setProps({ query });
    const current = view.wrapper.get<HTMLButtonElement>('[data-testid="model-selector-hf-submit"]');
    expect(current.text()).toBe(label);
    expect(current.element).toBe(button.element);
    expect(current.element.style.inlineSize).toBe('6rem');
  }
  expect(search).toHaveBeenCalledTimes(1);
});

it('debounces edits from the Hugging Face input after opt-in and keeps inherited queries local', async () => {
  vi.useFakeTimers();
  try {
    using view = fixture();
    await view.wrapper.get('[data-testid="model-selector-hf-filter"]').trigger('click');
    await view.wrapper.get('[data-testid="model-selector-hf-auto-search"]').trigger('click');
    await view.wrapper.setProps({ query: 'local inventory filter' });
    await vi.advanceTimersByTimeAsync(500);
    expect(search).not.toHaveBeenCalled();

    const input = view.wrapper.get('[data-testid="model-selector-hf-query"]');
    await input.setValue('speech');
    await view.wrapper.setProps({ query: 'speech' });
    await vi.advanceTimersByTimeAsync(300);
    await input.setValue('speech recognition');
    await view.wrapper.setProps({ query: 'speech recognition' });
    await vi.advanceTimersByTimeAsync(399);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'speech recognition', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });

    await input.setValue('https://huggingface.co/owner/model');
    await view.wrapper.setProps({ query: 'https://huggingface.co/owner/model' });
    await vi.advanceTimersByTimeAsync(500);
    expect(view.wrapper.emitted('select')).toBeUndefined();
    expect(search).toHaveBeenCalledTimes(1);

    await input.setValue('');
    await view.wrapper.setProps({ query: '' });
    await vi.advanceTimersByTimeAsync(400);
    expect(search.mock.calls[1]?.[0].query).toBe('');
  } finally {
    vi.useRealTimers();
  }
});

it('discloses the selected repository inside its row with the surrounding results still in place', async () => {
  search.mockResolvedValueOnce({ results: [{ id: 'owner/first' }, { id: 'owner/second' }], nextCursor: undefined });
  using view = fixture();
  await view.wrapper.get('form').trigger('submit');
  await flushPromises();
  const first = view.wrapper.get('[data-repository="owner/first"]').element;
  const second = view.wrapper.get('[data-repository="owner/second"]');
  await second.trigger('click');
  expect(view.wrapper.emitted('select')).toEqual([['owner/second', 'result']]);
  await view.wrapper.setProps({ expandedRepository: { repository: 'owner/second', source: 'result' } });
  expect(second.attributes('aria-expanded')).toBe('true');
  expect(view.wrapper.get('[data-testid="repository-details"]').element.closest('li')).toBe(second.element.closest('li'));
  expect(view.wrapper.get('[data-repository="owner/first"]').element).toBe(first);
  expect(view.wrapper.findAll('[data-testid="model-selector-hf-result"]')).toHaveLength(2);
});

it.each([
  'https://huggingface.co/owner/model/tree/main',
  'https://hf.co/owner/model/blob/main/model.gguf',
  'hf.co/owner/model',
])('selects the explicitly submitted repository URL %s without search or metadata requests', async query => {
  using view = fixture();
  await view.wrapper.setProps({ query });
  expect(view.wrapper.emitted('select')).toBeUndefined();
  await view.wrapper.get('form').trigger('submit');
  expect(view.wrapper.emitted('select')).toEqual([['owner/model', 'url']]);
  expect(search).not.toHaveBeenCalled();
});

it('searches repository-like text instead of treating a partial name as a direct selection', async () => {
  using view = fixture();
  await view.wrapper.setProps({ query: 'owner/model' });
  await view.wrapper.get('form').trigger('submit');
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'owner/model', cursor: undefined, numParameters: undefined, signal: expect.any(AbortSignal) });
  expect(view.wrapper.emitted('select')).toBeUndefined();
});

it('keeps typing and resubmission available while cancelling and ignoring an older search', async () => {
  const first = Promise.withResolvers<ModelSearchPage>();
  const second = Promise.withResolvers<ModelSearchPage>();
  search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  using view = fixture();
  await view.wrapper.get('form').trigger('submit');
  const oldSignal = search.mock.calls[0]?.[0].signal;
  expect(view.wrapper.get('[data-testid="model-selector-hf-query"]').attributes('disabled')).toBeUndefined();
  expect(view.wrapper.get('[data-testid="model-selector-hf-submit"]').attributes('disabled')).toBeUndefined();
  await view.wrapper.setProps({ query: 'new model' });
  expect(oldSignal?.aborted).toBe(true);
  expect(search).toHaveBeenCalledTimes(1);
  await view.wrapper.get('form').trigger('submit');
  second.resolve({ results: [{ id: 'new/model' }], nextCursor: undefined });
  await flushPromises();
  first.resolve({ results: [{ id: 'old/model' }], nextCursor: 'obsolete' });
  await flushPromises();
  expect(view.wrapper.findAll('[data-testid="model-selector-hf-result"]').map(row => row.text())).toEqual(['new/model']);
  expect(view.wrapper.find('[data-testid="model-selector-hf-more"]').exists()).toBe(false);
  await view.wrapper.get('[data-testid="model-selector-hf-result"]').trigger('click');
  expect(view.wrapper.emitted('select')).toEqual([['new/model', 'result']]);
  expect(search).toHaveBeenCalledTimes(2);
});

it('paginates the last submitted query, deduplicates rows and stops a repeated cursor', async () => {
  search.mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'next' });
  search.mockResolvedValueOnce({ results: [{ id: 'owner/first' }, { id: 'owner/second' }], nextCursor: 'next' });
  using view = fixture();
  await view.wrapper.get('form').trigger('submit');
  await flushPromises();
  await view.wrapper.setProps({ query: 'not submitted' });
  await view.wrapper.get('[data-testid="model-selector-hf-more"]').trigger('click');
  await flushPromises();
  expect(search.mock.calls[1]?.[0]).toEqual({ query: 'qwen', cursor: 'next', numParameters: undefined, signal: expect.any(AbortSignal) });
  expect(view.wrapper.findAll('[data-testid="model-selector-hf-result"]').map(row => row.text())).toEqual(['owner/first', 'owner/second']);
  expect(view.wrapper.find('[data-testid="model-selector-hf-more"]').exists()).toBe(false);
});

it('searches a parameter range only on submit and keeps that range for pagination', async () => {
  search.mockResolvedValueOnce({ results: [{ id: 'owner/first' }], nextCursor: 'next' });
  using view = fixture();
  await view.wrapper.setProps({ query: '' });
  await view.wrapper.get('[data-testid="model-selector-hf-filter"]').trigger('click');
  await view.wrapper.get('[data-testid="llama-hf-search-maximum"]').setValue('2.5');
  expect(search).not.toHaveBeenCalled();
  await view.wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: '', cursor: undefined, numParameters: 'max:2.5B', signal: expect.any(AbortSignal) });
  await view.wrapper.get('[data-testid="model-selector-hf-filter"]').trigger('click');
  await view.wrapper.get('[data-testid="llama-hf-search-maximum"]').setValue('4');
  expect(search).toHaveBeenCalledTimes(1);
  await view.wrapper.get('[data-testid="model-selector-hf-more"]').trigger('click');
  expect(search.mock.calls[1]?.[0]).toEqual({ query: '', cursor: 'next', numParameters: 'max:2.5B', signal: expect.any(AbortSignal) });
});

it.each(['inactive', 'disabled', 'disposed'] as const)('cancels pending pagination when %s and never applies its late page', async lifetime => {
  const page = Promise.withResolvers<ModelSearchPage>();
  search.mockResolvedValueOnce({ results: [{ id: 'owner/retained' }], nextCursor: 'next' }).mockReturnValueOnce(page.promise);
  using view = fixture();
  await view.wrapper.get('form').trigger('submit');
  await flushPromises();
  await view.wrapper.get('[data-testid="model-selector-hf-more"]').trigger('click');
  const signal = search.mock.calls[1]?.[0].signal;
  switch (lifetime) {
  case 'inactive': await view.wrapper.setProps({ active: false });
    break;
  case 'disabled': await view.wrapper.setProps({ disabled: true });
    break;
  case 'disposed': view.wrapper.unmount();
    break;
  default: {
    const exhaustive: never = lifetime;
    throw new Error(String(exhaustive));
  }
  }
  expect(signal?.aborted).toBe(true);
  page.resolve({ results: [{ id: 'late/model' }], nextCursor: undefined });
  await flushPromises();
  if (lifetime !== 'disposed') {
    await view.wrapper.get('form').trigger('submit');
    expect(search).toHaveBeenCalledTimes(2);
    await view.wrapper.setProps({ active: true, disabled: false });
    expect(search).toHaveBeenCalledTimes(2);
    expect(view.wrapper.findAll('[data-testid="model-selector-hf-result"]').map(row => row.text())).toEqual(['owner/retained']);
    expect(view.wrapper.find('[role="alert"]').exists()).toBe(false);
  }
});

it('ignores an old pagination result after a new submitted search', async () => {
  const page = Promise.withResolvers<ModelSearchPage>();
  search.mockResolvedValueOnce({ results: [{ id: 'old/first' }], nextCursor: 'old-next' });
  search.mockReturnValueOnce(page.promise);
  search.mockResolvedValueOnce({ results: [{ id: 'new/first' }], nextCursor: 'new-next' });
  using view = fixture();
  await view.wrapper.get('form').trigger('submit');
  await flushPromises();
  await view.wrapper.get('[data-testid="model-selector-hf-more"]').trigger('click');
  const oldSignal = search.mock.calls[1]?.[0].signal;
  await view.wrapper.setProps({ query: 'new' });
  await view.wrapper.get('form').trigger('submit');
  await flushPromises();
  page.resolve({ results: [{ id: 'old/late' }], nextCursor: undefined });
  await flushPromises();
  expect(oldSignal?.aborted).toBe(true);
  expect(view.wrapper.findAll('[data-testid="model-selector-hf-result"]').map(row => row.text())).toEqual(['new/first']);
  await view.wrapper.get('[data-testid="model-selector-hf-more"]').trigger('click');
  expect(search.mock.calls[3]?.[0]).toEqual({ query: 'new', cursor: 'new-next', numParameters: undefined, signal: expect.any(AbortSignal) });
});

it('shows search failures and allows retry without losing the completed result list', async () => {
  search.mockResolvedValueOnce({ results: [{ id: 'owner/kept' }], nextCursor: 'next' });
  search.mockRejectedValueOnce(new Error('HTTP 503'));
  search.mockResolvedValueOnce({ results: [{ id: 'owner/retry' }], nextCursor: undefined });
  using view = fixture();
  await view.wrapper.get('form').trigger('submit');
  await flushPromises();
  await view.wrapper.get('[data-testid="model-selector-hf-more"]').trigger('click');
  await flushPromises();
  expect(view.wrapper.find('[role="alert"]').exists()).toBe(true);
  expect(view.wrapper.get('[data-testid="model-selector-hf-result"]').text()).toBe('owner/kept');
  await view.wrapper.get('[data-testid="model-selector-hf-more"]').trigger('click');
  await flushPromises();
  expect(view.wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(view.wrapper.findAll('[data-testid="model-selector-hf-result"]').map(row => row.text())).toEqual(['owner/kept', 'owner/retry']);
});

it('rejects an invalid repository URL locally and permits a corrected direct selection', async () => {
  using view = fixture();
  await view.wrapper.setProps({ query: 'https://example.invalid/owner/model' });
  await view.wrapper.get('form').trigger('submit');
  expect(view.wrapper.find('[role="alert"]').exists()).toBe(true);
  expect(search).not.toHaveBeenCalled();
  expect(view.wrapper.emitted('select')).toBeUndefined();
  await view.wrapper.setProps({ query: 'https://huggingface.co/owner/model' });
  await view.wrapper.get('form').trigger('submit');
  expect(view.wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(view.wrapper.emitted('select')).toEqual([['owner/model', 'url']]);
  expect(search).not.toHaveBeenCalled();
});
