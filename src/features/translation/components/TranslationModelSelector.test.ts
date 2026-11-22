import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import type { RepositoryModelSelection } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import { defaultTranslationModel, translationModelSuggestions } from '@/features/translation/model-catalog';
import TranslationModelSelector from './TranslationModelSelector.vue';

const mocks = vi.hoisted(() => ({ list: vi.fn<typeof listModelInventory>(), mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: mocks.list }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { subscribeModelList: () => () => {} } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryPicker.vue', () => ({
  __esModule: true,
  default: {
    name: 'TestRepositoryPicker',
    props: ['layout', 'suggestions', 'selectionPolicy', 'repositoryUsage', 'popupTarget', 'disabled'],
    emits: ['select-model'],
    mounted: mocks.mounted,
    unmounted: mocks.unmounted,
    template: `<div :data-testid="layout"><input data-testid="repository-draft" /><button data-testid="catalog-select" @click="$emit('select-model', { modelId: 'saved.gguf' })">Select</button></div>`,
  },
}));
vi.mock('@/components/ModelSelectorFileImport.vue', () => ({ __esModule: true, default: { template: '<div data-testid="translation-files" />' } }));

const pendingModel: RepositoryModelSelection = {
  modelId: `hf.co/${defaultTranslationModel.hfRepository}:${defaultTranslationModel.preferredQuantization}`,
  source: { kind: 'bundled', repository: defaultTranslationModel.hfRepository, variant: defaultTranslationModel.preferredQuantization, companionPath: undefined },
  destination: { kind: 'opfs' },
  authorizeDestination: undefined,
};

beforeEach(async () => {
  mocks.mounted.mockClear();
  mocks.unmounted.mockClear();
  mocks.list.mockReset().mockResolvedValue([{ modelId: 'host/Models/pfnet/plamo-3-translate-2b-GGUF:Q4_K_M', size: 500, importedAt: 1 }]);
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture({ pending }: { pending: boolean }) {
  const host = document.createElement('div');
  document.body.append(host);
  const confirmSelection = vi.fn<({ modelId }: { modelId: string | undefined }) => Promise<boolean>>().mockResolvedValue(true);
  const wrapper = mount(TranslationModelSelector, {
    attachTo: host,
    props: { modelId: pending ? undefined : 'hf.co/pfnet/plamo-3-translate-2b-GGUF:Q4_K_M', pendingModel: pending ? pendingModel : undefined, pendingDestination: pending ? 'OPFS' : undefined, inventoryEpoch: 0, trackInventory: pending, acquiring: false, disabled: false, selectionBlocked: false, confirmSelection },
  });
  function popup() {
    return new DOMWrapper(document.body).get('[data-testid="model-selector-dropdown"]');
  }
  return {
    wrapper,
    confirmSelection,
    popup,
    async open() {
      wrapper.vm.openPicker();
      await flushPromises();
      await vi.dynamicImportSettled();
      await flushPromises();
    },
    async tab({ index }: { index: number }) {
      await popup().get('[data-testid="model-selector-tabs"]').findAll('button')[index]!.trigger('click');
      await vi.dynamicImportSettled();
      await flushPromises();
    },
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

describe('translation model selector', () => {
  it('keeps an unopened selector with a saved choice out of model inventory and catalog work', async () => {
    using f = fixture({ pending: false });
    await flushPromises();
    expect(f.wrapper.find('[data-testid="model-selector-download-hint"]').exists()).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.mounted).not.toHaveBeenCalled();
  });

  it('preselects the bundled default and puts catalog, device, Hugging Face, and files in one menu', async () => {
    using f = fixture({ pending: true });
    expect(f.wrapper.get('[data-testid="model-selector-first-use-destination"]').text()).toBe('OPFS');
    await f.open();
    const tabs = f.popup().get('[data-testid="model-selector-tabs"]').findAll('button');
    expect(tabs.map(tab => tab.attributes('aria-pressed'))).toEqual(['true', 'false', 'false', 'false']);
    const candidate = f.wrapper.getComponent({ name: 'TestRepositoryPicker' });
    expect(candidate.props('suggestions')).toEqual(translationModelSuggestions);
    expect(candidate.props('selectionPolicy')).toBe('first-use-download');
    await f.tab({ index: 1 });
    expect(f.popup().get('[data-testid="model-selector-option"]').text()).toContain('plamo-3-translate-2b-GGUF');
    await f.tab({ index: 2 });
    const query = f.popup().get('[data-testid="inline-results"] input');
    await query.setValue('private/repository');
    await f.tab({ index: 3 });
    expect(f.popup().find('[data-testid="translation-files"]').exists()).toBe(true);
    await f.tab({ index: 2 });
    expect((query.element as HTMLInputElement).value).toBe('private/repository');
    expect(mocks.mounted).toHaveBeenCalledTimes(2);
    expect(mocks.unmounted).not.toHaveBeenCalled();
  });

  it('opens from the sidebar shortcut and restores trigger focus after closing', async () => {
    using f = fixture({ pending: false });
    await f.open();
    expect(document.activeElement).toBe(f.popup().get('[data-testid="model-selector-filter"]').element);
    f.wrapper.vm.closePicker();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
    expect(document.activeElement).toBe(f.wrapper.get('[data-testid="model-selector-trigger"]').element);
  });

  it('handles Escape in the shared popup and respects an already consumed key', async () => {
    using f = fixture({ pending: false });
    await f.open();
    const filter = f.popup().get('[data-testid="model-selector-filter"]');
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    consumed.preventDefault();
    filter.element.dispatchEvent(consumed);
    await flushPromises();
    expect(f.popup().element).toBeInstanceOf(HTMLDialogElement);
    await filter.trigger('keydown', { key: 'Escape' });
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
    expect(f.wrapper.emitted('openChange')).toEqual([[true], [false]]);
  });

  it('uses the shared modal for the expanded picker', async () => {
    using f = fixture({ pending: false });
    await f.open();
    const dialog = f.popup().element as HTMLDialogElement;
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    await f.popup().get('[aria-label="Expand model selector"]').trigger('click');
    expect(f.popup().attributes('aria-modal')).toBe('true');
    await f.popup().get('[aria-label="Close"]').trigger('click');
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  });

  it('keeps the picker open when a stored model fails translation validation', async () => {
    using f = fixture({ pending: false });
    f.confirmSelection.mockResolvedValueOnce(false);
    await f.open();
    await f.popup().get('[data-testid="model-selector-option"]').trigger('click');
    await flushPromises();
    expect(f.confirmSelection).toHaveBeenCalledOnce();
    expect(f.popup().element).toBeInstanceOf(HTMLDialogElement);
    await f.popup().get('[data-testid="model-selector-option"]').trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  });
});
