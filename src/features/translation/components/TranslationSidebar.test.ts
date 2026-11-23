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
  const navigation: TranslationNavigation = { openWorkspace: vi.fn() };
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
  it('keeps only translation in the sidebar while it is the current page', async () => {
    using f = await fixture();
    const owner = f.wrapper.element;
    const workspace = f.wrapper.get('[data-testid="translation-nav-workspace"]');
    expect(f.wrapper.findAll('button')).toHaveLength(1);
    expect(f.wrapper.element).toBe(owner);
    expect(workspace.attributes('aria-current')).toBe('page');
    expect(f.router.currentRoute.value.path).toBe('/translation');
    await workspace.trigger('click');
    expect(f.navigation.openWorkspace).toHaveBeenCalledOnce();
  });

  it('keeps the icon-only translation control named when collapsed', async () => {
    expanded.value = false;
    using f = await fixture();
    const button = f.wrapper.get('[data-testid="translation-nav-workspace"]');
    expect(button.attributes('aria-label')).toBeTruthy();
    expect(button.find('span').exists()).toBe(false);
    await button.trigger('click');
    expect(f.navigation.openWorkspace).toHaveBeenCalledOnce();
  });
});
