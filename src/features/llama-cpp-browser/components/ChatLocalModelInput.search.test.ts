import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed } from 'vue';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import { searchModels, type RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatLocalModelInput from './ChatLocalModelInput.vue';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';
import LlamaCppBrowserRepositoryPicker from './LlamaCppBrowserRepositoryPicker.vue';

const preparation = vi.hoisted(() => ({ tasks: [] as (() => Promise<void>)[] }));
vi.mock('@/utils/idle-task', () => ({
  scheduleIdleTask: ({ task }: { task: () => Promise<void> }) => {
    preparation.tasks.push(task);
    return { cancel: vi.fn() };
  },
}));
vi.mock('../composables/model-inventory', () => ({ listModelInventory: vi.fn() }));
const metadata = vi.hoisted(() => ({ inspect: vi.fn(), installed: vi.fn() }));
vi.mock('../hugging-face/catalog', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), searchModels: vi.fn() }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: metadata.inspect }) }));
vi.mock('../hugging-face/storage', () => ({ installedSelection: metadata.installed }));
vi.mock('../composables/useChatBrowserModelPickerTab', () => ({ useChatBrowserModelPickerTab: () => ({ remembered: computed(() => 'hugging-face'), remember: vi.fn(async () => {}) }) }));

const results = Array.from({ length: 40 }, (_, index) => ({ id: `owner/model-${index}`, downloads: index + 1 }));
const catalog: RepositoryCatalog = {
  repository: results[0]!.id,
  revision: 'a'.repeat(40),
  projectors: [],
  models: [{ label: 'Q4_K_M', size: 256, files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] }],
};

beforeEach(async () => {
  vi.resetAllMocks();
  preparation.tasks = [];
  vi.mocked(listModelInventory).mockResolvedValue([]);
  vi.mocked(searchModels).mockResolvedValue({ results, nextCursor: 'next-page' });
  metadata.inspect.mockResolvedValue(catalog);
  metadata.installed.mockResolvedValue(undefined);
  await ensureAllStringsForTest({ locale: 'en' });
});

function renderPicker({ layout }: { layout: 'welcome' | 'embedded' }) {
  const state = {
    operation: computed(() => undefined),
    downloadJob: computed(() => undefined),
    useModel: vi.fn(async () => {}),
    useRepositoryModel: vi.fn(async () => {}),
    pauseDownload: vi.fn(),
    maySend: computed(() => true),
    accept: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies ChatLocalModelUi;
  const wrapper = mount(ChatLocalModelInput, { props: { layout, scrollMode: 'source', sourceTabsHost: undefined, state, expansion: 'closed', availability: 'available' } });
  return {
    wrapper,
    state,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

async function openSearch({ wrapper }: { wrapper: VueWrapper }): Promise<void> {
  const opener = wrapper.find('[data-testid="chat-open-local-model"]');
  if (opener.exists()) {
    await opener.trigger('click');
  }
  await wrapper.setProps({ expansion: 'open' });
  await vi.dynamicImportSettled();
  await flushPromises();
}

async function submitSearch({ wrapper }: { wrapper: VueWrapper }): Promise<void> {
  await wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
  await wrapper.get('[data-testid="llama-hf-search-submit"]').trigger('click');
  await flushPromises();
}

it('gives the real search chain one scrolling parent while keeping tabs and the disclosure outside it', async () => {
  using view = renderPicker({ layout: 'welcome' });
  expect(view.wrapper.findComponent(LlamaCppBrowserRepositoryPicker).exists()).toBe(false);
  await openSearch({ wrapper: view.wrapper });
  const search = view.wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch);
  const tab = view.wrapper.get('[data-testid="chat-model-tab-hugging-face"]');
  const pane = view.wrapper.get<HTMLElement>(`#${tab.attributes('aria-controls')}`);
  const viewport = view.wrapper.get('[data-testid="chat-model-source-viewport"]').element;
  expect(search.props('scrollOwner')).toBe('parent');
  const controls = view.wrapper.get('[data-testid="llama-hf-search-controls"]');
  expect(controls.classes()).toContain('sticky');
  expect(controls.classes()).toContain('top-0');
  expect(controls.element.contains(view.wrapper.get('[data-testid="llama-hf-search-query"]').element)).toBe(true);
  expect(controls.element.contains(view.wrapper.get('[data-testid="llama-hf-search-submit"]').element)).toBe(true);
  expect(pane.classes()).toContain('overflow-y-auto');
  expect(pane.element.contains(tab.element)).toBe(false);
  expect(pane.element.contains(view.wrapper.get('[data-testid="chat-open-local-model"]').element)).toBe(false);
  await view.wrapper.get('[data-testid="llama-hf-search-filter-toggle"]').trigger('click');
  expect(controls.element.contains(view.wrapper.get('fieldset').element)).toBe(false);
  await view.wrapper.get('[data-testid="llama-hf-search-query"]').setValue('qwen');
  expect(searchModels).not.toHaveBeenCalled();
  expect(metadata.inspect).not.toHaveBeenCalled();
  await submitSearch({ wrapper: view.wrapper });
  const list = view.wrapper.get('[data-testid="llama-hf-search-results"]');
  // Guard the ownership contract in jsdom; actual clipping needs browser layout.
  expect(list.classes()).not.toContain('max-h-64');
  let ancestor: Element | undefined = list.element;
  while (ancestor !== undefined && ancestor !== pane.element) {
    expect(ancestor.classList.contains('overflow-y-auto')).toBe(false);
    expect(ancestor.classList.contains('overflow-y-scroll')).toBe(false);
    ancestor = ancestor.parentElement ?? undefined;
  }
  expect(ancestor).toBe(pane.element);
  expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(40);
  expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').classes()).toContain('scroll-mt-36');
  expect(pane.element.contains(view.wrapper.get('[data-testid="llama-hf-search-more"]').element)).toBe(true);
  pane.element.scrollTop = 180;
  await view.wrapper.get('[data-testid="chat-model-tab-files"]').trigger('click');
  await tab.trigger('click');
  await view.wrapper.setProps({ expansion: 'closed' });
  await view.wrapper.setProps({ expansion: 'open' });
  await flushPromises();
  expect(view.wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).element).toBe(search.element);
  expect(view.wrapper.get('[data-testid="chat-model-source-viewport"]').element).toBe(viewport);
  expect(pane.element.scrollTop).toBe(180);
  expect(searchModels).toHaveBeenCalledOnce();
});

it('keeps the same list and scroll position through explicit paging, failure, and retry', async () => {
  using view = renderPicker({ layout: 'welcome' });
  await openSearch({ wrapper: view.wrapper });
  await submitSearch({ wrapper: view.wrapper });
  const search = view.wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).element;
  const tab = view.wrapper.get('[data-testid="chat-model-tab-hugging-face"]');
  const pane = view.wrapper.get<HTMLElement>(`#${tab.attributes('aria-controls')}`).element;
  const firstRow = view.wrapper.get('[data-testid="llama-hf-search-result"]').element;
  pane.scrollTop = 240;
  const page = Promise.withResolvers<Awaited<ReturnType<typeof searchModels>>>();
  vi.mocked(searchModels).mockReturnValueOnce(page.promise);
  await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
  expect(view.wrapper.get('[data-testid="llama-hf-search-more"]').attributes('aria-busy')).toBe('true');
  expect(view.wrapper.get<HTMLButtonElement>('[data-testid="llama-hf-search-more"]').element.disabled).toBe(true);
  page.reject(new Error('offline'));
  await flushPromises();
  expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(40);
  expect(view.wrapper.find('[data-testid="llama-hf-search-more-error"]').exists()).toBe(true);
  const retry = view.wrapper.get<HTMLButtonElement>('[data-testid="llama-hf-search-more"]');
  expect(retry.isVisible()).toBe(true);
  expect(retry.text()).toBe('Retry');
  expect(retry.element.disabled).toBe(false);
  expect(retry.element.compareDocumentPosition(view.wrapper.get('[data-testid="llama-hf-search-more-error"]').element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(retry.attributes('aria-describedby')).toBe(view.wrapper.get('[data-testid="llama-hf-search-more-error"]').attributes('id'));
  expect(searchModels).toHaveBeenCalledTimes(2);
  const next = Array.from({ length: 20 }, (_, index) => ({ id: `owner/next-${index}` }));
  vi.mocked(searchModels).mockResolvedValueOnce({ results: next, nextCursor: 'third-page' });
  await view.wrapper.get('[data-testid="llama-hf-search-more"]').trigger('click');
  await flushPromises();
  expect(vi.mocked(searchModels).mock.calls[2]?.[0]).toMatchObject({ query: 'qwen', cursor: 'next-page' });
  expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(60);
  expect(view.wrapper.get('[data-testid="llama-hf-search-result"]').element).toBe(firstRow);
  expect(view.wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).element).toBe(search);
  expect(pane.scrollTop).toBe(240);
  expect(view.wrapper.find('[data-testid="llama-hf-search-more-error"]').exists()).toBe(false);
  expect(metadata.inspect).not.toHaveBeenCalled();
});

it('opens configuration at the top and restores the search position and results on return', async () => {
  using view = renderPicker({ layout: 'welcome' });
  await openSearch({ wrapper: view.wrapper });
  await submitSearch({ wrapper: view.wrapper });
  const tab = view.wrapper.get('[data-testid="chat-model-tab-hugging-face"]');
  const pane = view.wrapper.get<HTMLElement>(`#${tab.attributes('aria-controls')}`).element;
  const search = view.wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).element;
  pane.scrollTop = 320;
  await view.wrapper.get('[data-testid="llama-hf-search-result"]').trigger('click');
  await flushPromises();
  expect(view.wrapper.find('[data-testid="chat-model-configuration"]').exists()).toBe(true);
  expect(pane.scrollTop).toBe(0);
  await view.wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(view.state.useRepositoryModel).toHaveBeenCalledExactlyOnceWith({ target: expect.objectContaining({ selection: expect.objectContaining({ repository: catalog.repository }) }), destination: { kind: 'opfs' }, authorizeDestination: expect.any(Function) });
  await view.wrapper.get('[data-testid="chat-model-back-to-search"]').trigger('click');
  await flushPromises();
  expect(pane.scrollTop).toBe(320);
  expect(view.wrapper.getComponent(LlamaCppBrowserHuggingFaceSearch).element).toBe(search);
  expect(view.wrapper.get<HTMLInputElement>('[data-testid="llama-hf-search-query"]').element.value).toBe('qwen');
  expect(view.wrapper.findAll('[data-testid="llama-hf-search-result"]')).toHaveLength(40);
  expect(searchModels).toHaveBeenCalledOnce();
  expect(metadata.inspect).toHaveBeenCalledOnce();
});

it('prepares the real inactive pickers without network access, inventory scans, or model changes', async () => {
  using view = renderPicker({ layout: 'welcome' });
  using fetch = vi.spyOn(globalThis, 'fetch');
  await openSearch({ wrapper: view.wrapper });
  for (let index = 0; index < 3; index++) {
    await preparation.tasks[index]!();
    await flushPromises();
  }
  expect(view.wrapper.find('[data-testid=chat-saved-model-picker]').exists()).toBe(true);
  expect(view.wrapper.find('[data-testid=chat-linked-folders-panel]').exists()).toBe(true);
  expect(view.wrapper.get('[data-testid=chat-saved-model-picker]').element.closest('[inert]')).not.toBeNull();
  expect(searchModels).not.toHaveBeenCalled();
  expect(metadata.inspect).not.toHaveBeenCalled();
  expect(listModelInventory).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(view.state.useModel).not.toHaveBeenCalled();
  expect(view.state.useRepositoryModel).not.toHaveBeenCalled();
  await view.wrapper.get('[data-testid=chat-model-tab-saved]').trigger('click');
  await flushPromises();
  expect(listModelInventory).toHaveBeenCalledOnce();
});

it.each(['welcome', 'embedded'] as const)('uses the shared saved-model action from the repository picker in the %s layout', async layout => {
  const model = { modelId: 'hf.co/owner/model-0:Q4_K_M', size: 256, importedAt: 1 };
  metadata.installed.mockResolvedValue(model);
  using view = renderPicker({ layout });
  await openSearch({ wrapper: view.wrapper });
  await view.wrapper.get('[data-testid="chat-model-repository"]').setValue(catalog.repository);
  await view.wrapper.get('[data-testid="chat-model-repository-check"]').trigger('click');
  await flushPromises();
  await view.wrapper.get('[data-testid="chat-use-repository-model"]').trigger('click');
  expect(view.state.useModel).toHaveBeenCalledExactlyOnceWith({ model });
  expect(view.state.useRepositoryModel).not.toHaveBeenCalled();
  expect(metadata.inspect).toHaveBeenCalledOnce();
});
