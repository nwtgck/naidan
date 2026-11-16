import { beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useLauncher } from '@/composables/useLauncher';
import { useOverlay } from '@/composables/useOverlay';
import type { RecentChatWithAccess } from '@/composables/useRecentChats';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LauncherModal from './LauncherModal.vue';

const settings = ref<{ experimental?: { unimplementedLauncherEntries?: 'show' | 'hide' } }>({});
const mostRecentChat = ref<RecentChatWithAccess>();
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/composables/useRecentChats', () => ({ useRecentChats: () => ({ mostRecentChat }) }));
vi.mock('./DeveloperToolsPanel.vue', () => ({ default: { emits: ['navigate', 'openModelSupportInvestigation'], template: '<section data-testid="developer-panel-stub"><button data-testid="developer-action" @click="$emit(\'navigate\', \'restore\')">Developer action</button><button data-testid="developer-handoff" @click="$emit(\'navigate\', \'handoff\')">Developer handoff</button></section>' } }));

beforeEach(async () => {
  useOverlay().closeOverlay();
  settings.value = {};
  mostRecentChat.value = undefined;
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture({ initial }: { initial: 'entries' | 'developer' | undefined }) {
  const overlay = useOverlay(), launcher = useLauncher();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: defineComponent({ render: () => undefined }) }] });
  router.onError(() => {});
  await router.push('/');
  await router.isReady();
  const opener = document.createElement('button'), host = document.createElement('div');
  document.body.append(opener, host);
  opener.focus();
  if (initial !== undefined) {
    launcher.openLauncher({ view: initial });
  }
  const wrapper = mount(LauncherModal, { attachTo: host, global: { plugins: [router], stubs: { transition: false } } });
  return {
    wrapper,
    router,
    launcher,
    overlay,
    opener,
    modal: () => document.querySelector<HTMLElement>('[data-testid="launcher-modal"]'),
    get({ testId }: { testId: string }): HTMLElement {
      const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (element === null) {
        throw new Error(`Missing ${testId}`);
      }
      return element;
    },
    async [Symbol.asyncDispose]() {
      launcher.closeLauncher();
      overlay.closeOverlay();
      wrapper.unmount();
      opener.remove();
      host.remove();
      await nextTick();
      await vi.waitFor(() => expect(document.querySelector('[data-testid="launcher-modal"]')).toBeNull());
    },
  };
}

it('handles IME/default-prevented Escape, closes normally and restores the connected opener', async () => {
  await using f = await fixture({ initial: 'entries' });
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-search' })));
  f.get({ testId: 'launcher-search' }).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
  expect(f.launcher.isLauncherOpen.value).toBe(true);
  const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  consumed.preventDefault();
  f.get({ testId: 'launcher-search' }).dispatchEvent(consumed);
  expect(f.launcher.isLauncherOpen.value).toBe(true);
  f.get({ testId: 'launcher-search' }).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(f.modal()).toBeNull());
  expect(f.overlay.activeOverlay.value).toBe('none');
  expect(document.activeElement).toBe(f.opener);
  f.launcher.openLauncher({ view: 'entries' });
  await nextTick();
  f.get({ testId: 'launcher-close' }).click();
  await vi.waitFor(() => expect(f.modal()).toBeNull());
  expect(document.activeElement).toBe(f.opener);
});

it('replaces another overlay without restoring focus into it or closing its replacement', async () => {
  await using f = await fixture({ initial: undefined });
  f.overlay.openOverlay({ type: 'search' });
  f.launcher.openLauncher({ view: 'entries' });
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-search' })));
  expect(f.overlay.activeOverlay.value).toBe('launcher');
  f.overlay.openOverlay({ type: 'recent' });
  await vi.waitFor(() => expect(f.modal()).toBeNull());
  expect(document.activeElement).not.toBe(f.opener);
  f.launcher.closeLauncher();
  expect(f.overlay.activeOverlay.value).toBe('recent');
});

it('focuses an initially opened developer view, preserves search on back, and traps Tab in the entry view', async () => {
  await using f = await fixture({ initial: 'developer' });
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-back' })));
  expect(document.querySelector('[data-testid="developer-panel-stub"]')).not.toBeNull();
  f.get({ testId: 'launcher-back' }).click();
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-search' })));
  const search = f.get({ testId: 'launcher-search' });
  if (!(search instanceof HTMLInputElement)) {
    throw new Error('Expected a search input');
  }
  search.value = 'voice';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  f.get({ testId: 'launcher-developer' }).click();
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-back' })));
  f.get({ testId: 'launcher-back' }).click();
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-search' })));
  const returned = f.get({ testId: 'launcher-search' });
  expect(returned).toHaveProperty('value', 'voice');
  expect(Array.from(f.modal()!.querySelectorAll<HTMLAnchorElement>('a[data-testid="launcher-entry"]')).map(link => link.getAttribute('href'))).toEqual(['/audio-generation', '/live-conversation']);
  const first = f.get({ testId: 'launcher-search' }), last = f.get({ testId: 'launcher-developer' });
  first.focus();
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(last);
  last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(first);
});

it('keeps modified clicks and failed navigation open, then closes only after a successful navigation', async () => {
  await using f = await fixture({ initial: 'entries' });
  await nextTick();
  const link = f.modal()!.querySelector<HTMLAnchorElement>('a[href="/translation"]')!;
  // Let the component see an unconsumed modified click, then suppress jsdom's native navigation.
  const preventNative: EventListener = event => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault();
  };
  link.addEventListener('click', preventNative, { once: true });
  link.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true }));
  await flushPromises();
  expect(f.launcher.isLauncherOpen.value).toBe(true);
  expect(f.router.currentRoute.value.path).toBe('/');
  const removeFailure = f.router.beforeEach(() => {
    throw new Error('route unavailable');
  });
  link.click();
  await vi.waitFor(() => expect(f.modal()?.querySelector('[role="alert"]')?.textContent).toContain('route unavailable'));
  expect(f.launcher.isLauncherOpen.value).toBe(true);
  removeFailure();
  const gate = Promise.withResolvers<void>(), entered = vi.fn();
  using navigation = {
    remove: f.router.beforeEach(async () => {
      entered();
      await gate.promise;
    }),
    [Symbol.dispose]() {
      gate.resolve();
      this.remove();
    },
  };
  link.click();
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  expect(f.launcher.isLauncherOpen.value).toBe(true);
  expect(f.router.currentRoute.value.path).toBe('/');
  gate.resolve();
  await vi.waitFor(() => expect(f.launcher.isLauncherOpen.value).toBe(false));
  expect(f.router.currentRoute.value.path).toBe('/translation');
  expect(document.activeElement).not.toBe(f.opener);
  void navigation;
});

it('restores the opener after selecting the current route or a developer action that stays on it', async () => {
  await using f = await fixture({ initial: undefined });
  await f.router.push('/translation');
  f.launcher.openLauncher({ view: 'entries' });
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-search' })));
  f.modal()!.querySelector<HTMLAnchorElement>('a[href="/translation"]')!.click();
  await vi.waitFor(() => expect(f.modal()).toBeNull());
  expect(document.activeElement).toBe(f.opener);
  f.launcher.openLauncher({ view: 'developer' });
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-back' })));
  f.get({ testId: 'developer-action' }).click();
  await vi.waitFor(() => expect(f.modal()).toBeNull());
  expect(document.activeElement).toBe(f.opener);
});

it('does not restore the launcher opener over a developer focus handoff', async () => {
  await using f = await fixture({ initial: 'developer' });
  await vi.waitFor(() => expect(document.activeElement).toBe(f.get({ testId: 'launcher-back' })));
  const handoff = f.get({ testId: 'developer-handoff' });
  handoff.focus();
  handoff.click();
  await vi.waitFor(() => expect(f.modal()).toBeNull());
  expect(f.overlay.activeOverlay.value).toBe('none');
  expect(document.activeElement).not.toBe(f.opener);
});
