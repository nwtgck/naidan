import { beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { AppEntryInteraction } from '@/composables/useAppEntry';
import type { AppInteraction } from '@/composables/useAppPresentation';
import { useLauncher } from '@/composables/useLauncher';
import { useOverlay } from '@/composables/useOverlay';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LauncherButton from './LauncherButton.vue';

const entryInteraction = ref<AppEntryInteraction>('ready');
const appInteraction = ref<AppInteraction>('enabled');
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ interaction: entryInteraction }) }));
vi.mock('@/composables/useAppPresentation', async importOriginal => ({
  ...await importOriginal<typeof import('@/composables/useAppPresentation')>(),
  useAppPresentation: () => ({ appInteraction }),
}));

beforeEach(async () => {
  useOverlay().closeOverlay();
  entryInteraction.value = 'ready';
  appInteraction.value = 'enabled';
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture({ expanded }: { expanded: boolean }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: defineComponent({ render: () => undefined }) }] });
  await router.push('/');
  await router.isReady();
  const wrapper = mount(LauncherButton, { props: { expanded }, global: { plugins: [router] } });
  return {
    wrapper,
    router,
    [Symbol.dispose]() {
      wrapper.unmount();
      useOverlay().closeOverlay();
    },
  };
}

it('opens from the ready Home sidebar in both expanded and collapsed layouts', async () => {
  using f = await fixture({ expanded: true });
  const launcher = useLauncher();
  const button = f.wrapper.get('[data-testid="open-launcher"]');
  expect(f.router.currentRoute.value.path).toBe('/');
  expect(button.attributes('disabled')).toBeUndefined();
  await button.trigger('click');
  expect(launcher.isLauncherOpen.value).toBe(true);
  expect(launcher.view.value).toBe('entries');
  launcher.closeLauncher();
  await f.wrapper.setProps({ expanded: false });
  expect(button.attributes('disabled')).toBeUndefined();
  await button.trigger('click');
  expect(launcher.isLauncherOpen.value).toBe(true);
  expect(button.attributes('aria-haspopup')).toBe('dialog');
});

it('reactively disables opening during startup, model selection, or a blocked entry', async () => {
  using f = await fixture({ expanded: true });
  const button = f.wrapper.get('[data-testid="open-launcher"]');
  for (const interaction of ['blocked-by-startup', 'blocked-by-model-selection'] as const) {
    appInteraction.value = interaction;
    await nextTick();
    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(useLauncher().isLauncherOpen.value).toBe(false);
  }
  appInteraction.value = 'enabled';
  entryInteraction.value = 'blocked';
  await nextTick();
  expect(button.attributes('disabled')).toBeDefined();
  await button.trigger('click');
  expect(useLauncher().isLauncherOpen.value).toBe(false);
  entryInteraction.value = 'ready';
  await nextTick();
  expect(button.attributes('disabled')).toBeUndefined();
  await button.trigger('click');
  expect(useLauncher().isLauncherOpen.value).toBe(true);
});
