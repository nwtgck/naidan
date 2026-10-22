import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter, type LocationQuery } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { provideAppEntry, useAppEntry } from '@/composables/useAppEntry';
import type { StartupState } from '@/logic/startup/types';
import MainAppSurface from './MainAppSurface.vue';

enableAutoUnmount(afterEach);

const pageSetup = vi.fn();
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'existing-model' });
const imageNavigation = ref<Record<string, never>>();
const settingsStore = {
  initialized: ref(true),
  settings,
  captureExperimentalStorage: () => () => true,
  deferModelRefresh: vi.fn(),
  resumeModelRefresh: vi.fn(),
};

vi.mock('@/composables/useSettings', () => ({ useSettings: () => settingsStore }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: ref(true), isDebugOpen: ref(false) }) }));
vi.mock('@/features/image-generation/session/navigation', () => ({ useImageGenerationWorkspaceNavigation: () => ({ active: imageNavigation }) }));
vi.mock('@/components/Sidebar.vue', () => ({ default: { template: '<div data-testid="sidebar" />' } }));
vi.mock('@/features/image-generation/components/ImageGenerationSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div data-testid="image-sidebar" />' } }));
vi.mock('@/components/AppEntrySurface.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: defineComponent({
    setup() {
      const entry = useAppEntry();
      const input = computed(() => {
        const intent = entry.intent.value;
        const kind = intent.kind;
        switch (kind) {
        case 'pending':
          return undefined;
        case 'home':
        case 'model-preview':
        case 'ordinary':
          return intent.input;
        default: {
          const _ex: never = kind;
          return _ex;
        }
        }
      });
      return () => h('div', { 'data-testid': 'entry-surface', 'data-input': JSON.stringify(input.value) });
    },
  }),
}));

async function mountSurface({ path, query }: { path: string, query: LocationQuery }) {
  const page = defineComponent({
    setup() {
      pageSetup();
      return () => h('div', { 'data-testid': 'ordinary-page' });
    },
  });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: page }] });
  await router.push({ path, query });
  const startupState = shallowRef<StartupState>({ kind: 'ready', mainApp: page });
  const host = defineComponent({
    setup() {
      provideAppEntry({ startupState });
      return () => h(MainAppSurface, { postStartupFeatures: 'active' });
    },
  });
  const wrapper = mount(host, { global: { plugins: [router], stubs: { transition: false } } });
  await flushPromises();
  return { router, wrapper };
}

describe('MainAppSurface entry routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imageNavigation.value = undefined;
  });

  it.each(['/', '/chat/existing', '/settings/connection', '/image-generation', '/audio-generation', '/unexpected'])('intercepts the model intent before setting up the destination page: %s', async path => {
    imageNavigation.value = path === '/image-generation' ? {} : undefined;
    const query = { 'llama-cpp-browser-model': 'owner/repository', q: 'ignored', settings: 'storage', 'global-model': 'ignored', 'global-endpoint-type': 'openai', 'global-endpoint-url': 'https://ignored.example' };
    const { router, wrapper } = await mountSurface({ path, query });
    const expectedUrl = router.resolve({ path, query }).fullPath;
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ordinary-page"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="image-sidebar"]').exists()).toBe(false);
    expect(pageSetup).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe(expectedUrl);
  });

  it.each(['', null, ['owner/first', 'owner/second']])('preserves invalid or ambiguous model input for explicit preview: %j', async input => {
    const { wrapper } = await mountSurface({ path: '/chat/existing', query: { 'llama-cpp-browser-model': input } });
    expect(wrapper.get('[data-testid="entry-surface"]').attributes('data-input')).toBe(JSON.stringify(input));
    expect(pageSetup).not.toHaveBeenCalled();
  });

  it('mounts the ordinary destination only after leaving the model intent and intercepts it on return', async () => {
    const location = { path: '/chat/existing', query: { 'llama-cpp-browser-model': 'owner/repository' } };
    const { router, wrapper } = await mountSurface(location);
    expect(pageSetup).not.toHaveBeenCalled();
    await router.replace('/chat/existing');
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ordinary-page"]').exists()).toBe(true);
    expect(pageSetup).toHaveBeenCalledOnce();
    await router.push(location);
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ordinary-page"]').exists()).toBe(false);
    expect(pageSetup).toHaveBeenCalledOnce();
  });

  it('shows an explicit home without setting up the underlying route', async () => {
    const { wrapper } = await mountSurface({ path: '/home', query: {} });
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(true);
    expect(pageSetup).not.toHaveBeenCalled();
  });
});
