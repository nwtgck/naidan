import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ChangeListener } from '@/00-storage/service/synchronizer';
import type { StorageType } from '@/01-models/types';
import type { ImageGenerationHistoryPage } from '@/01-models/image-generation-history';
import { toBinaryObjectId, toImageGenerationId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from './ImageGenerationLab.vue';
import ImageGenerationHistory from './ImageGenerationHistory.vue';

const mocks = vi.hoisted(() => ({ query: vi.fn(), dispose: vi.fn(), subscribe: vi.fn(), getType: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: {
  subscribeToChanges: mocks.subscribe,
  getCurrentType: mocks.getType,
  getFile: async () => undefined,
} }));
vi.mock('../history/worker/client-hosted', () => ({ createImageHistoryClient: () => ({ query: mocks.query, dispose: mocks.dispose }) }));
vi.mock('../use-image-benchmark', () => import('@/features/stable-diffusion-cpp-browser/use-image-benchmark-standalone'));
vi.mock('../use-image-generation', async () => {
  const { useImageGeneration: createForm } = await import('@/features/stable-diffusion-cpp-browser/use-image-generation-standalone');
  const { useImageGenerationHistory } = await import('@/features/stable-diffusion-cpp-browser/history/use-image-generation-history');
  const { onScopeDispose } = await import('vue');
  return { useImageGeneration() {
    // Only unrelated inference/model controls use the UI-only facade. The Lab
    // and history owner exercise their real lifecycle and migration handling.
    const history = useImageGenerationHistory({ getStorageType: () => mocks.getType() });
    onScopeDispose(() => {
      void history.dispose();
    });
    return { ...createForm(), history };
  } };
});

let wrapper: VueWrapper<InstanceType<typeof ImageGenerationLab>> | undefined;
let listener: ChangeListener | undefined;
function page({ prompt }: { prompt: string }): ImageGenerationHistoryPage {
  return { items: [{ id: toImageGenerationId({ raw: 'saved-record' }), createdAt: 1, prompt, modelName: 'fixture',
    binaryObjectId: toBinaryObjectId({ raw: 'saved-image' }), width: 256, height: 256, previewCount: 0 }],
  total: 81, warnings: [], warningCount: 0 };
}
async function migrate({ type }: { type: StorageType }): Promise<void> {
  mocks.getType.mockReturnValue(type);
  listener?.({ event: { type: 'migration', timestamp: Date.now() } });
  await flushPromises();
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks(); mocks.getType.mockReturnValue('opfs');
  mocks.query.mockResolvedValue(page({ prompt: 'saved forest' }));
  mocks.subscribe.mockImplementation(({ listener: next }: { listener: ChangeListener }) => {
    listener = next; return () => {
      listener = undefined;
    };
  });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});

it.each(['memory', 'local'] as const)('refreshes visible history when OPFS returns from %s while preserving the search', async type => {
  wrapper = mount(ImageGenerationLab, { props: { tab: 'history' } }); await flushPromises();
  const history = wrapper.getComponent(ImageGenerationHistory).props('view');
  expect(history.items.value).toHaveLength(1);
  history.setQuery({ text: 'forest' }); await history.reload();
  await history.goToPage({ page: 2 });
  expect(mocks.query).toHaveBeenLastCalledWith({ query: { text: 'forest', offset: 40, limit: 40 } });
  mocks.query.mockClear();
  await migrate({ type });
  expect(history.available.value).toBe(false);
  expect(history.items.value).toEqual([]);
  expect(mocks.query).not.toHaveBeenCalled();
  await migrate({ type: 'opfs' });
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith({ query: { text: 'forest', offset: 0, limit: 40 } });
  expect(history.items.value[0]?.prompt).toBe('saved forest');
  expect(history.currentPage.value).toBe(1);
  expect(wrapper.get('[data-testid="image-history-workspace"]').text()).toContain('saved forest');
});

it('keeps restored OPFS history lazy while another tab is active', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  await migrate({ type: 'memory' }); await migrate({ type: 'opfs' });
  expect(mocks.query).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="image-tab-history"]').trigger('click'); await flushPromises();
  expect(mocks.query).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-testid="image-history-workspace"]').text()).toContain('saved forest');
});

it('passes a separate record-delete lock while form and binary actions remain disabled', async () => {
  wrapper = mount(ImageGenerationLab, { props: { tab: 'history' } }); await flushPromises();
  const history = wrapper.getComponent(ImageGenerationHistory);
  expect(history.props('disabled')).toBe(true);
  expect(history.props('recordDeleteDisabled')).toBe(false);
});

it('ignores an old query and refreshes the visible tab after OPFS returns', async () => {
  const pending = Promise.withResolvers<ImageGenerationHistoryPage>();
  mocks.query.mockReturnValueOnce(pending.promise);
  wrapper = mount(ImageGenerationLab, { props: { tab: 'history' } }); await flushPromises();
  const history = wrapper.getComponent(ImageGenerationHistory).props('view');
  await migrate({ type: 'memory' }); await migrate({ type: 'opfs' });
  expect(mocks.query).toHaveBeenCalledOnce();
  pending.resolve(page({ prompt: 'stale image' })); await flushPromises();
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(history.items.value[0]?.prompt).toBe('saved forest');
  expect(history.loading.value).toBe(false);
  expect(wrapper.get('[data-testid="image-history-workspace"]').text()).not.toContain('stale image');
});
