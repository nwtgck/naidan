import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { requestAppSettings } from '@/composables/useAppEntry';
import type { AppInteraction } from '@/composables/useAppPresentation';
import { ensureStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import DeveloperToolsPanel from './DeveloperToolsPanel.vue';
import DeveloperToolsSidebar from './DeveloperToolsSidebar.vue';

const interaction = shallowRef<'ready' | 'blocked'>('ready');
const appInteraction = shallowRef<AppInteraction>('enabled');
const launcherOpener = shallowRef<HTMLElement>();
const capability = vi.hoisted(() => ({ modelSupport: true }));
vi.mock('@/composables/useLauncher', () => ({ useLauncher: () => ({ opener: launcherOpener }) }));
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ interaction }), requestAppSettings: vi.fn<typeof requestAppSettings>() }));
vi.mock('@/composables/useAppPresentation', async importOriginal => ({
  ...await importOriginal<typeof import('@/composables/useAppPresentation')>(),
  useAppPresentation: () => ({ appInteraction }),
}));
vi.mock('@/features/transformers-js/model-support-investigation', () => ({
  get isModelSupportInvestigationAvailable() {
    return capability.modelSupport;
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  interaction.value = 'ready';
  appInteraction.value = 'enabled';
  launcherOpener.value = undefined;
  capability.modelSupport = true;
  vi.stubGlobal('__BUILD_MODE_IS_HOSTED__', true);
  vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', false);
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fixture({ expanded, initial }: { expanded: boolean, initial: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: defineComponent({ render: () => undefined }) }] });
  router.onError(() => {});
  await router.push(initial);
  await router.isReady();
  const wrapper = mount(DeveloperToolsSidebar, { props: { expanded }, attachTo: document.body, global: { plugins: [router] } });
  return {
    router,
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

it('shares entries and environment restrictions with the panel while rendering a sidebar body', async () => {
  using f = await fixture({ expanded: true, initial: '/llama-cpp-browser/diagnostics?repeats=3' });
  using panel = {
    wrapper: mount(DeveloperToolsPanel, { global: { plugins: [f.router] } }),
    [Symbol.dispose]() {
      this.wrapper.unmount();
    },
  };
  const ids = ['llama-diagnostics', 'standalone-verification', 'transformers-model-support', 'image-diagnostics', 'audio-response', 'transcription', 'developer-settings'];
  expect(f.wrapper.findAll('button')).toHaveLength(ids.length);
  for (const id of ids) {
    const button = f.wrapper.get(`[data-testid="developer-sidebar-${id}"]`);
    expect(button.attributes('disabled')).toBe(panel.wrapper.get(`[data-testid="developer-tool-${id}"]`).attributes('disabled'));
    expect(button.attributes('aria-label')).toBeTruthy();
  }
  expect(f.wrapper.get('[data-testid="developer-sidebar-llama-diagnostics"]').attributes('aria-current')).toBe('page');
  expect(f.wrapper.find('[data-testid="open-launcher"]').exists()).toBe(false);
  await f.wrapper.get('[data-testid="developer-sidebar-llama-diagnostics"]').trigger('click');
  await flushPromises();
  expect(f.router.currentRoute.value.fullPath).toBe('/llama-cpp-browser/diagnostics?repeats=3');
});

it('keeps collapsed actions named and navigates to the existing image and live diagnostic families', async () => {
  using f = await fixture({ expanded: false, initial: '/debug' });
  expect(f.wrapper.findAll('h2')).toHaveLength(0);
  for (const button of f.wrapper.findAll('button')) {
    expect(button.attributes('aria-label')).toBeTruthy();
    expect(button.attributes('title')).toBe(button.attributes('aria-label'));
  }
  for (const [id, path] of [['image-diagnostics', '/image-generation/diagnostics'], ['audio-response', '/live-conversation/diagnostics'], ['transcription', '/live-conversation/diagnostics/transcription']]) {
    await f.wrapper.get(`[data-testid="developer-sidebar-${id}"]`).trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe(path);
    expect(f.wrapper.get(`[data-testid="developer-sidebar-${id}"]`).attributes('aria-current')).toBe('page');
  }
});

it('passes the clicked model-support opener to the existing modal owner', async () => {
  using f = await fixture({ expanded: false, initial: '/debug' });
  const button = f.wrapper.get('[data-testid="developer-sidebar-transformers-model-support"]');
  await button.trigger('click');
  expect(f.wrapper.emitted('openModelSupportInvestigation')).toEqual([[button.element]]);
  expect(f.router.currentRoute.value.path).toBe('/debug');
});

it('returns settings focus to its own persistent button rather than a stale launcher opener', async () => {
  using stale = {
    element: document.createElement('button'),
    [Symbol.dispose]() {
      this.element.remove();
    },
  };
  document.body.append(stale.element);
  launcherOpener.value = stale.element;
  using f = await fixture({ expanded: true, initial: '/debug' });
  const button = f.wrapper.get('[data-testid="developer-sidebar-developer-settings"]');
  await button.trigger('click');
  expect(requestAppSettings).toHaveBeenCalledExactlyOnceWith({ tab: 'developer', opener: button.element });
});

it('keeps unavailable entries and their reasons reachable in standalone without executing them', async () => {
  vi.stubGlobal('__BUILD_MODE_IS_HOSTED__', false);
  vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', true);
  capability.modelSupport = false;
  using f = await fixture({ expanded: false, initial: '/debug' });
  for (const id of ['transformers-model-support', 'image-diagnostics', 'audio-response', 'transcription']) {
    const button = f.wrapper.get(`[data-testid="developer-sidebar-${id}"]`);
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('aria-label')).toContain(await ensureStrings.DeveloperToolsPanel__hosted_version_only());
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  expect(f.wrapper.emitted('openModelSupportInvestigation')).toBeUndefined();
  expect(f.router.currentRoute.value.path).toBe('/debug');
  await f.wrapper.get('[data-testid="developer-sidebar-standalone-verification"]').trigger('click');
  await flushPromises();
  expect(f.router.currentRoute.value.path).toBe('/debug/standalone');
});

it('keeps a rejected navigation visible for retry and respects the global interaction gate', async () => {
  using f = await fixture({ expanded: true, initial: '/debug' });
  const button = f.wrapper.get('[data-testid="developer-sidebar-llama-diagnostics"]');
  appInteraction.value = 'blocked-by-model-selection';
  await flushPromises();
  expect(button.attributes('disabled')).toBeDefined();
  await button.trigger('click');
  expect(f.router.currentRoute.value.path).toBe('/debug');
  appInteraction.value = 'enabled';
  await flushPromises();
  using failure = {
    remove: f.router.beforeEach(() => {
      throw new Error('navigation unavailable');
    }),
    [Symbol.dispose]() {
      this.remove();
    },
  };
  await button.trigger('click');
  await flushPromises();
  expect(f.wrapper.get('[data-testid="developer-sidebar-navigation-error"]').text()).toContain('navigation unavailable');
  failure.remove();
  await button.trigger('click');
  await flushPromises();
  expect(f.wrapper.find('[data-testid="developer-sidebar-navigation-error"]').exists()).toBe(false);
  expect(f.router.currentRoute.value.path).toBe('/llama-cpp-browser/diagnostics');
});
