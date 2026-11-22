import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { TranslationNavigation } from '@/features/translation/navigation';
import TranslationSidebar from './TranslationSidebar.vue';

const expanded = ref(true);
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: expanded }) }));

beforeEach(async () => {
  expanded.value = true;
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture() {
  const navigation: TranslationNavigation = { openWorkspace: vi.fn(), openModels: vi.fn() };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/translation');
  const wrapper = mount(TranslationSidebar, { props: { navigation }, global: { plugins: [router] } });
  return {
    wrapper,
    navigation,
    router,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Translation sidebar content', () => {
  it('delegates the model shortcut and keeps translation as the current page', async () => {
    using f = await fixture();
    const owner = f.wrapper.element;
    const workspace = f.wrapper.get('[data-testid="translation-nav-workspace"]');
    const models = f.wrapper.get('[data-testid="translation-nav-models"]');
    expect(workspace.attributes('aria-current')).toBe('page');
    await models.trigger('click');
    expect(f.navigation.openModels).toHaveBeenCalledOnce();
    expect(f.wrapper.element).toBe(owner);
    expect(models.attributes('aria-haspopup')).toBe('dialog');
    expect(workspace.attributes('aria-current')).toBe('page');
    expect(f.router.currentRoute.value.path).toBe('/translation');
    await workspace.trigger('click');
    expect(f.navigation.openWorkspace).toHaveBeenCalledOnce();
  });

  it('keeps both icon-only destinations named when collapsed', async () => {
    expanded.value = false;
    using f = await fixture();
    for (const id of ['translation-nav-workspace', 'translation-nav-models']) {
      const button = f.wrapper.get(`[data-testid="${id}"]`);
      expect(button.attributes('aria-label')).toBeTruthy();
      expect(button.find('span').exists()).toBe(false);
      await button.trigger('click');
    }
    expect(f.navigation.openWorkspace).toHaveBeenCalledOnce();
    expect(f.navigation.openModels).toHaveBeenCalledOnce();
  });
});
