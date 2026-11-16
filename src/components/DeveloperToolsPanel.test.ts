import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import DeveloperToolsPanel from './DeveloperToolsPanel.vue';
import { requestAppSettings } from '@/composables/useAppEntry';
import type { AppInteraction } from '@/composables/useAppPresentation';
import { ensureStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

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

const destinations = [
  ['llama-diagnostics', '/llama-cpp-browser/diagnostics'],
  ['image-diagnostics', '/image-generation/diagnostics'],
  ['audio-response', '/live-conversation/diagnostics'],
  ['transcription', '/live-conversation/diagnostics/transcription'],
] as const;

async function fixture({ initial }: { initial: string }) {
  const empty = defineComponent({ setup: () => () => h('div') });
  const router = createRouter({ history: createMemoryHistory(), routes: ['/', '/debug/standalone', ...destinations.map(([, path]) => path)].map(path => ({ path, component: empty })) });
  await router.push(initial);
  await router.isReady();
  const wrapper = mount(DeveloperToolsPanel, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return {
    wrapper,
    router,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

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

it('shows the existing investigations and settings without owning the modal header', async () => {
  using f = await fixture({ initial: '/' });
  expect(f.wrapper.findAll('h3').map(heading => heading.text())).toEqual([await ensureStrings.DeveloperToolsPanel__investigations(), await ensureStrings.DeveloperToolsPanel__settings()]);
  expect(f.wrapper.findAll('button')).toHaveLength(7);
  expect(f.wrapper.find('h2').exists()).toBe(false);
  const standalone = f.wrapper.get('[data-testid="developer-tool-standalone-verification"]');
  expect(standalone.attributes('disabled')).toBeDefined();
  expect(standalone.text()).toContain(await ensureStrings.DeveloperToolsPanel__standalone_version_only());
  expect(f.wrapper.get('[data-testid="developer-tool-transformers-model-support"]').attributes('disabled')).toBeUndefined();
});

it.each(destinations)('opens the real %s page and asks the parent to close after navigation', async (id, path) => {
  using f = await fixture({ initial: '/' });
  await f.wrapper.get(`[data-testid="developer-tool-${id}"]`).trigger('click');
  await flushPromises();
  expect(f.router.currentRoute.value.path).toBe(path);
  expect(f.wrapper.emitted('navigate')).toEqual([['restore']]);
  expect(f.wrapper.emitted('openModelSupportInvestigation')).toBeUndefined();
});

it('preserves diagnostic URL settings when reopening the current page', async () => {
  using f = await fixture({ initial: '/llama-cpp-browser/diagnostics?repeats=3' });
  using spy = {
    push: vi.spyOn(f.router, 'push'),
    [Symbol.dispose]() {
      this.push.mockRestore();
    },
  };
  await f.wrapper.get('[data-testid="developer-tool-llama-diagnostics"]').trigger('click');
  await flushPromises();
  expect(spy.push).not.toHaveBeenCalled();
  expect(f.router.currentRoute.value.fullPath).toBe('/llama-cpp-browser/diagnostics?repeats=3');
  expect(f.wrapper.emitted('navigate')).toEqual([['restore']]);
});

it('opens developer settings through the app entry owner with the button as focus return target', async () => {
  using f = await fixture({ initial: '/' });
  const button = f.wrapper.get('[data-testid="developer-tool-developer-settings"]');
  await button.trigger('click');
  expect(requestAppSettings).toHaveBeenCalledExactlyOnceWith({ tab: 'developer', opener: button.element });
  expect(f.router.currentRoute.value.path).toBe('/');
  expect(f.wrapper.emitted('navigate')).toEqual([['handoff']]);
});

it('requests the existing model support modal without inventing a route', async () => {
  using f = await fixture({ initial: '/' });
  await f.wrapper.get('[data-testid="developer-tool-transformers-model-support"]').trigger('click');
  expect(f.wrapper.emitted('openModelSupportInvestigation')).toEqual([[]]);
  expect(f.wrapper.emitted('navigate')).toBeUndefined();
  expect(f.router.currentRoute.value.path).toBe('/');
});

it('returns settings focus to the original launcher trigger after this panel disappears', async () => {
  using trigger = {
    element: document.createElement('button'),
    [Symbol.dispose]() {
      this.element.remove();
    },
  };
  document.body.append(trigger.element);
  launcherOpener.value = trigger.element;
  let received: HTMLElement | undefined;
  {
    using f = await fixture({ initial: '/' });
    await f.wrapper.get('[data-testid="developer-tool-developer-settings"]').trigger('click');
    expect(requestAppSettings).toHaveBeenCalledExactlyOnceWith({ tab: 'developer', opener: trigger.element });
    received = vi.mocked(requestAppSettings).mock.calls[0]![0].opener;
  }
  expect(received?.isConnected).toBe(true);
});

it('keeps hosted-only entries visible with reasons in standalone and opens the standalone verification page', async () => {
  vi.stubGlobal('__BUILD_MODE_IS_HOSTED__', false);
  vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', true);
  capability.modelSupport = false;
  using f = await fixture({ initial: '/' });
  for (const id of ['transformers-model-support', 'image-diagnostics', 'audio-response', 'transcription']) {
    const button = f.wrapper.get(`[data-testid="developer-tool-${id}"]`);
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain(await ensureStrings.DeveloperToolsPanel__hosted_version_only());
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  await flushPromises();
  expect(f.wrapper.emitted('navigate')).toBeUndefined();
  expect(f.wrapper.emitted('openModelSupportInvestigation')).toBeUndefined();
  await f.wrapper.get('[data-testid="developer-tool-standalone-verification"]').trigger('click');
  await flushPromises();
  expect(f.router.currentRoute.value.path).toBe('/debug/standalone');
  expect(f.wrapper.emitted('navigate')).toEqual([['restore']]);
});

it('keeps navigation errors readable and allows an explicit retry', async () => {
  using f = await fixture({ initial: '/' });
  using spy = {
    push: vi.spyOn(f.router, 'push').mockRejectedValueOnce(new Error('Navigation could not complete')),
    [Symbol.dispose]() {
      this.push.mockRestore();
    },
  };
  await f.wrapper.get('[data-testid="developer-tool-audio-response"]').trigger('click');
  await flushPromises();
  expect(f.wrapper.get('[data-testid="developer-tools-navigation-error"]').text()).toContain('Navigation could not complete');
  expect(f.wrapper.emitted('navigate')).toBeUndefined();
  await f.wrapper.get('[data-testid="developer-tool-audio-response"]').trigger('click');
  await flushPromises();
  expect(f.wrapper.find('[data-testid="developer-tools-navigation-error"]').exists()).toBe(false);
  expect(f.router.currentRoute.value.path).toBe('/live-conversation/diagnostics');
  expect(f.wrapper.emitted('navigate')).toEqual([['restore']]);
  void spy;
});

it.each(['startup', 'model-selection'] as const)('does not execute actions while blocked by %s', async reason => {
  using f = await fixture({ initial: '/' });
  switch (reason) {
  case 'startup': interaction.value = 'blocked';
    break;
  case 'model-selection': appInteraction.value = 'blocked-by-model-selection';
    break;
  default: {
    const exhaustive: never = reason;
    throw new Error(String(exhaustive));
  }
  }
  await flushPromises();
  for (const button of f.wrapper.findAll('button')) {
    expect(button.attributes('disabled')).toBeDefined();
    button.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  await flushPromises();
  expect(f.router.currentRoute.value.path).toBe('/');
  expect(requestAppSettings).not.toHaveBeenCalled();
  expect(f.wrapper.emitted('navigate')).toBeUndefined();
  expect(f.wrapper.emitted('openModelSupportInvestigation')).toBeUndefined();
});
