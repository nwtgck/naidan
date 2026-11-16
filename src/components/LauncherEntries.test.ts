import { beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { toChatId } from '@/01-models/ids';
import type { RecentChatWithAccess } from '@/composables/useRecentChats';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import HomeLauncherEntries from './HomeLauncherEntries.vue';
import LauncherEntryList from './LauncherEntryList.vue';

const settings = ref<{ experimental?: { unimplementedLauncherEntries?: 'show' | 'hide' } }>({});
const mostRecentChat = ref<RecentChatWithAccess>();
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/composables/useRecentChats', () => ({ useRecentChats: () => ({ mostRecentChat }) }));

beforeEach(async () => {
  settings.value = {};
  mostRecentChat.value = undefined;
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture({ component }: { component: typeof HomeLauncherEntries | typeof LauncherEntryList }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: defineComponent({ render: () => undefined }) }] });
  router.onError(() => {});
  await router.push('/');
  await router.isReady();
  const wrapper = mount(component, { props: { query: '', blocked: false }, global: { plugins: [router] } });
  return {
    router,
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function entries({ wrapper }: { wrapper: Awaited<ReturnType<typeof fixture>>['wrapper'] }) {
  return wrapper.findAll('[data-testid="launcher-entry"]').map(entry => ({ text: entry.text(), href: entry.attributes('href'), unavailable: entry.attributes('aria-disabled') }));
}

it('keeps Home and dialog content, order and routes synchronized through visibility, category and search changes', async () => {
  using home = await fixture({ component: HomeLauncherEntries });
  using dialog = await fixture({ component: LauncherEntryList });
  expect(entries(home)).toEqual(entries(dialog));
  expect(home.wrapper.findAll('[data-testid="launcher-entry"]')).toHaveLength(6);
  settings.value = { experimental: { unimplementedLauncherEntries: 'show' } };
  await nextTick();
  expect(entries(home)).toEqual(entries(dialog));
  expect(home.wrapper.findAll('[data-testid="launcher-entry"]')).toHaveLength(11);
  for (const surface of [home, dialog]) {
    const unavailable = surface.wrapper.findAll('[data-testid="launcher-entry"][aria-disabled="true"]');
    expect(unavailable).toHaveLength(5);
    expect(unavailable.every(entry => entry.element.tagName !== 'A' && entry.attributes('href') === undefined && entry.find('a').exists() === false)).toBe(true);
    await surface.wrapper.get('[data-testid="launcher-category-write"]').trigger('click');
    expect(surface.wrapper.get('[data-testid="launcher-category-write"]').attributes('aria-pressed')).toBe('true');
    await surface.wrapper.setProps({ query: '  VOICE  ' });
  }
  expect(entries(home)).toEqual(entries(dialog));
  expect(home.wrapper.findAll('a[data-testid="launcher-entry"]').map(entry => entry.attributes('href'))).toEqual(['/live-conversation']);
  const reserved = home.wrapper.findAll('a[aria-hidden="true"]');
  expect(reserved.length).toBeGreaterThan(0);
  expect(reserved.every(entry => entry.attributes('inert') !== undefined && entry.attributes('data-testid') === undefined)).toBe(true);
  for (const surface of [home, dialog]) {
    await surface.wrapper.get('[data-testid="launcher-category-all"]').trigger('click');
  }
  expect(home.wrapper.findAll('a[data-testid="launcher-entry"]').map(entry => entry.attributes('href'))).toEqual(['/audio-generation', '/live-conversation']);
  expect(entries(home)).toEqual(entries(dialog));
  expect(home.wrapper.findAll('[aria-disabled="true"][data-testid="launcher-entry"]')).toHaveLength(1);
  settings.value = { experimental: { unimplementedLauncherEntries: 'hide' } };
  await nextTick();
  expect(entries(home)).toEqual(entries(dialog));
  expect(home.wrapper.findAll('[data-testid="launcher-entry"]')).toHaveLength(2);
});

it('updates the first Chat link on both surfaces as the recent chat changes and falls back to Home', async () => {
  using home = await fixture({ component: HomeLauncherEntries });
  using dialog = await fixture({ component: LauncherEntryList });
  for (const surface of [home, dialog]) {
    expect(surface.wrapper.get('[data-testid="launcher-entry"]').attributes('href')).toBe('/');
  }
  for (const raw of ['last-opened', 'newer-chat']) {
    mostRecentChat.value = { id: toChatId({ raw }), title: 'Recent chat', updatedAt: 100, accessedAt: 200, groupId: undefined };
    await nextTick();
    for (const surface of [home, dialog]) {
      const first = surface.wrapper.get('[data-testid="launcher-entry"]');
      expect(first.attributes('href')).toBe(`/chat/${raw}`);
      await first.trigger('click');
      await flushPromises();
      expect(surface.router.currentRoute.value.path).toBe(`/chat/${raw}`);
    }
  }
  mostRecentChat.value = undefined;
  await nextTick();
  for (const surface of [home, dialog]) {
    const first = surface.wrapper.get('[data-testid="launcher-entry"]');
    expect(first.attributes('href')).toBe('/');
    await first.trigger('click');
    await flushPromises();
    expect(surface.router.currentRoute.value.path).toBe('/');
    expect(surface.wrapper.emitted('navigate')).toHaveLength(3);
  }
});

for (const { name, component } of [{ name: 'Home', component: HomeLauncherEntries }, { name: 'dialog', component: LauncherEntryList }]) {
  it(`${name} waits for navigation to succeed before emitting navigate`, async () => {
    using surface = await fixture({ component });
    const entered = vi.fn(), gate = Promise.withResolvers<void>();
    using navigation = {
      remove: surface.router.beforeEach(async () => {
        entered();
        await gate.promise;
      }),
      [Symbol.dispose]() {
        gate.resolve();
        this.remove();
      },
    };
    await surface.wrapper.get('a[href="/translation"]').trigger('click');
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    expect(surface.router.currentRoute.value.path).toBe('/');
    expect(surface.wrapper.emitted('navigate')).toBeUndefined();
    gate.resolve();
    await flushPromises();
    expect(surface.router.currentRoute.value.path).toBe('/translation');
    expect(surface.wrapper.emitted('navigate')).toHaveLength(1);
    void navigation;
  });

  it(`${name} blocks disabled input and keeps failed navigation visible until a successful retry`, async () => {
    using surface = await fixture({ component });
    const enter = vi.fn(() => false);
    const remove = surface.router.beforeEach(enter);
    await surface.wrapper.setProps({ blocked: true });
    expect(surface.wrapper.get('[data-testid="launcher-category-write"]').attributes('disabled')).toBeDefined();
    await surface.wrapper.get('a[href="/translation"]').trigger('click');
    expect(enter).not.toHaveBeenCalled();
    await surface.wrapper.setProps({ blocked: false });
    await surface.wrapper.get('a[href="/translation"]').trigger('click');
    await vi.waitFor(() => expect(surface.wrapper.find('[role="alert"]').exists()).toBe(true));
    expect(surface.router.currentRoute.value.path).toBe('/');
    expect(surface.wrapper.emitted('navigate')).toBeUndefined();
    remove();
    await surface.wrapper.get('a[href="/translation"]').trigger('click');
    await flushPromises();
    expect(surface.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(surface.wrapper.emitted('navigate')).toHaveLength(1);
    // Selecting the already-current feature should also finish the launcher action.
    await surface.wrapper.get('a[href="/translation"]').trigger('click');
    await flushPromises();
    expect(surface.wrapper.emitted('navigate')).toHaveLength(2);
    expect(surface.wrapper.find('[role="alert"]').exists()).toBe(false);
  });
}
