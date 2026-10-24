import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import type { ModelSelectionPresentation } from '@/composables/useAppEntry';
import { toChatId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import BrowserModelLibrary from './BrowserModelLibrary.vue';

const mocks = vi.hoisted(() => ({ useModel: vi.fn(), updateGlobal: vi.fn(), startLocal: vi.fn(), closeDiscovery: vi.fn(), closeModelSelection: vi.fn() }));
const selection = ref<ModelSelectionPresentation>();
const model = { modelId: 'user/local-model', size: 100, importedAt: 1 };
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({ endpoint: { type: 'openai', url: 'https://example.invalid' }, defaultModelId: 'remote-model' }), updateGlobalModelAndEndpoint: mocks.updateGlobal }) }));
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ modelSelection: selection, closeDiscovery: mocks.closeDiscovery, closeModelSelection: mocks.closeModelSelection }) }));
vi.mock('@/composables/useLocalModelStart', () => ({ useLocalModelStart: () => ({ startLocalModel: mocks.startLocal }) }));
vi.mock('@/features/llama-cpp-browser/composables/useRecentModelImports', () => ({ useRecentModelImports: () => ({ prune: vi.fn() }) }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserModelLibrary.vue', () => ({
  default: defineComponent({
    props: ['suspended', 'inventory', 'defaultModel', 'applyDefaultModel', 'createChatGroup'],
    setup(props, { slots }) {
      return () => h('div', slots['model-actions']?.({ model, disabled: props.suspended }));
    },
  }),
}));
enableAutoUnmount(afterEach);

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
  selection.value = { phase: 'open', owner: Symbol('chat-selection'), target: { kind: 'chat', chatId: toChatId({ raw: 'existing' }), acceptFiles: () => {}, useRepositoryModel: () => {}, useModel: mocks.useModel }, selection: { suggestionId: 'gemma-4-e2b', quantizationId: undefined }, opener: undefined };
});

it.each([false, true])('uses a saved model only in the requesting chat (suspended=%s)', async suspended => {
  const wrapper = mount(BrowserModelLibrary, { props: { suspended, inventory: { models: [model], hostIssues: [], error: undefined, refreshing: false, refresh: async () => {} } } });
  await wrapper.get('[data-testid="discovery-use-model-user/local-model"]').trigger('click');
  expect(mocks.useModel).toHaveBeenCalledTimes(suspended ? 0 : 1);
  if (!suspended) {
    expect(mocks.useModel).toHaveBeenCalledWith({ model });
    expect(mocks.closeDiscovery).toHaveBeenCalledOnce();
    expect(mocks.closeModelSelection).toHaveBeenCalledOnce();
  }
  expect(mocks.updateGlobal).not.toHaveBeenCalled();
  expect(mocks.startLocal).not.toHaveBeenCalled();
});
