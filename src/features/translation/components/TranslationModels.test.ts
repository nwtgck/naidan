import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import TranslationModels from './TranslationModels.vue';

const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue', () => ({
  default: {
    name: 'TestModelManager',
    props: ['modelView', 'scrollOwner', 'runtimeSettings', 'selectionAction', 'suspended'],
    mounted: lifecycle.mounted,
    unmounted: lifecycle.unmounted,
    template: '<div data-testid="manager" :data-view="modelView"><input data-testid="repository-draft" /></div>',
  },
}));

beforeEach(async () => {
  lifecycle.mounted.mockClear();
  lifecycle.unmounted.mockClear();
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture() {
  const wrapper = mount(TranslationModels, { attachTo: document.body, props: { suspended: false, disabled: false, modelId: undefined } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
      wrapper.element.remove();
    },
  };
}

describe('translation model tabs', () => {
  it('keeps one manager and one scroll pane while switching catalog, repository and local models', async () => {
    using f = fixture();
    const pane = f.wrapper.get('[role="tabpanel"]').element;
    await f.wrapper.get('[data-testid="repository-draft"]').setValue('private/repository');
    const manager = f.wrapper.getComponent({ name: 'TestModelManager' });
    expect(manager.props()).toMatchObject({ modelView: 'catalog', scrollOwner: 'parent', runtimeSettings: 'hide', selectionAction: 'select' });
    for (const view of ['repository', 'local', 'catalog']) {
      await f.wrapper.get(`[data-testid="translation-model-tab-${view}"]`).trigger('click');
      expect(manager.props('modelView')).toBe(view);
      expect(f.wrapper.get('[role="tabpanel"]').element).toBe(pane);
      expect(f.wrapper.get<HTMLInputElement>('[data-testid="repository-draft"]').element.value).toBe('private/repository');
    }
    expect(lifecycle.mounted).toHaveBeenCalledOnce();
    expect(lifecycle.unmounted).not.toHaveBeenCalled();
  });

  it('supports roving keyboard selection, resets pane scroll and labels the active panel', async () => {
    using f = fixture();
    const pane = f.wrapper.get<HTMLElement>('[role="tabpanel"]');
    pane.element.scrollTop = 150;
    await f.wrapper.get('[role="tablist"]').trigger('keydown', { key: 'End' });
    await flushPromises();
    const selected = f.wrapper.get('[aria-selected="true"]');
    expect(selected.attributes('data-testid')).toBe('translation-model-tab-local');
    expect(pane.attributes('aria-labelledby')).toBe(selected.attributes('id'));
    expect(document.activeElement).toBe(selected.element);
    expect(pane.element.scrollTop).toBe(0);
    await f.wrapper.setProps({ suspended: true });
    await f.wrapper.get('[data-testid="translation-model-tab-catalog"]').trigger('click');
    expect(f.wrapper.getComponent({ name: 'TestModelManager' }).props('modelView')).toBe('local');
  });
});
