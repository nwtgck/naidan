import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import SidebarHeader from './SidebarHeader.vue';
const openHome = vi.hoisted(() => vi.fn());
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ openHome }) }));
let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  openHome.mockClear();
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('shares the logo, Naidan name, build version and collapse action between sidebars', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/home', component: { template: '<div />' } }] });
  await router.push('/');
  await router.isReady();
  wrapper = mount(SidebarHeader, { props: { expanded: true }, global: { plugins: [router] }, slots: { status: '<span data-testid="status-slot">memory</span>' } });
  expect(wrapper.text()).toContain('Naidan');
  expect(wrapper.text()).toContain(`v${__APP_VERSION__}`);
  expect(wrapper.find('[data-testid="status-slot"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="model-downloads-trigger"]').exists()).toBe(false);
  expect(wrapper.get('a').attributes('href')).toBe('/home');
  await wrapper.get('a').trigger('click', { ctrlKey: true });
  expect(openHome).not.toHaveBeenCalled();
  await wrapper.get('a').trigger('click');
  expect(openHome).toHaveBeenCalledOnce();
  await wrapper.get('[data-testid="sidebar-toggle"]').trigger('click');
  expect(wrapper.emitted('toggle')).toHaveLength(1);
  await wrapper.setProps({ expanded: false });
  expect(wrapper.find('a').exists()).toBe(false);
  expect(wrapper.find('[data-testid="sidebar-toggle"]').exists()).toBe(true);
});
