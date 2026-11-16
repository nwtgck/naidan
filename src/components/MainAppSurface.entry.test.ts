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
const settingsStore = {
  initialized: ref(true),
  settings,
  captureExperimentalStorage: () => () => true,
  deferModelRefresh: vi.fn(),
  resumeModelRefresh: vi.fn(),
};

vi.mock('@/composables/useSettings', () => ({ useSettings: () => settingsStore }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: ref(true), isDebugOpen: ref(false) }) }));
vi.mock('@/components/HomeWelcome.vue', () => ({ default: { template: '<div data-testid="home-welcome" />' } }));
vi.mock('@/components/AppSidebar.vue', () => ({ default: { name: 'AppSidebar', props: ['postStartupFeatures'], template: '<div data-testid="app-sidebar" :data-activation="postStartupFeatures" />' } }));
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
  });

  it.each(['/', '/chat/existing', '/settings/connection', '/image-generation', '/live-conversation', '/audio-generation', '/unexpected'])('intercepts the model intent before setting up the destination page: %s', async path => {
    const query = { 'llama-cpp-browser-model': 'owner/repository', q: 'ignored', settings: 'storage', 'global-model': 'ignored', 'global-endpoint-type': 'openai', 'global-endpoint-url': 'https://ignored.example' };
    const { router, wrapper } = await mountSurface({ path, query });
    const expectedUrl = router.resolve({ path, query }).fullPath;
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ordinary-page"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="app-sidebar"]').attributes('data-activation')).toBe('active');
    expect(pageSetup).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe(expectedUrl);
  });

  it('renders the ordinary Live Conversation destination alongside the common sidebar', async () => {
    const { wrapper } = await mountSurface({ path: '/live-conversation', query: {} });
    expect(wrapper.find('[data-testid="app-sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ordinary-page"]').exists()).toBe(true);
    expect(pageSetup).toHaveBeenCalledOnce();
  });

  it.each(['', null, ['owner/first', 'owner/second']])('preserves invalid or ambiguous model input for explicit preview: %j', async input => {
    const { wrapper } = await mountSurface({ path: '/chat/existing', query: { 'llama-cpp-browser-model': input } });
    expect(wrapper.get('[data-testid="entry-surface"]').attributes('data-input')).toBe(JSON.stringify(input));
    expect(pageSetup).not.toHaveBeenCalled();
  });

  it('mounts the ordinary destination only after leaving the model intent and intercepts it on return', async () => {
    const location = { path: '/chat/existing', query: { 'llama-cpp-browser-model': 'owner/repository' } };
    const { router, wrapper } = await mountSurface(location);
    const sidebar = wrapper.get('[data-testid="app-sidebar"]').element;
    expect(pageSetup).not.toHaveBeenCalled();
    await router.replace('/chat/existing');
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ordinary-page"]').exists()).toBe(true);
    expect(pageSetup).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);
    await router.push(location);
    await flushPromises();
    expect(wrapper.find('[data-testid="entry-surface"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ordinary-page"]').exists()).toBe(false);
    expect(pageSetup).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);
  });

  it('shows the root home without setting up the underlying route or a previously selected chat', async () => {
    const { wrapper } = await mountSurface({ path: '/', query: {} });
    expect(wrapper.find('[data-testid="home-welcome"]').exists()).toBe(true);
    expect(pageSetup).not.toHaveBeenCalled();
  });
});
