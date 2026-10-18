import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { toNaidanRpcPeerPublicKey, toNaidanRpcRegistrationId, type NaidanRpcRegistrationId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import SettingsSelect from '@/components/SettingsSelect.vue';
import RpcRegistrationSelect from './RpcRegistrationSelect.vue';

const fixture = vi.hoisted(() => ({
  rows: [] as RpcRegistrationView[],
  reload: vi.fn(),
  getManager: vi.fn(),
  push: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({
  getRpcManager: fixture.getManager,
  subscribeRpcState: ({ listener }: { listener(): void }) => {
    fixture.listeners.add(listener);
    return () => fixture.listeners.delete(listener);
  },
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: fixture.push, currentRoute: { value: { query: { retained: 'value' } } } }) }));

function registration({ rawId, label, persistence }: { rawId: string, label: string, persistence: RpcRegistrationView['persistence'] }): RpcRegistrationView {
  return {
    registration: {
      id: toNaidanRpcRegistrationId({ raw: rawId }),
      label,
      peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) }),
      localPublicKey: 'A'.repeat(43),
      transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.example', headers: [] },
      inboundAllowedMethods: [],
      connectOnStartup: 'disabled',
      revision: 0,
    },
    phase: 'disconnected',
    persistence,
    registryPersistence: persistence === 'saved' ? 'durable' : undefined,
    access: { effective: [], desired: [], saved: [], revision: 0, persistence },
    failure: undefined,
    desiredConnection: 'disconnected',
    recoveryStatus: 'ready',
    health: undefined,
    connectionToken: undefined,
  };
}

function mountSelector({ surface, modelValue }: { surface: 'default' | 'settings' | undefined, modelValue: NaidanRpcRegistrationId | undefined }) {
  const wrapper = mount(RpcRegistrationSelect, { attachTo: document.body, props: { surface, modelValue } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function optionButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
}

beforeEach(async () => {
  vi.resetAllMocks();
  fixture.rows = [
    registration({ rawId: 'saved', label: 'Saved computer', persistence: 'saved' }),
    registration({ rawId: 'temporary', label: 'Temporary computer', persistence: 'temporary' }),
  ];
  fixture.reload.mockResolvedValue(undefined);
  fixture.getManager.mockResolvedValue({ reload: fixture.reload, list: () => fixture.rows });
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  fixture.listeners.clear();
  document.body.innerHTML = '';
});

describe('RpcRegistrationSelect settings surface', () => {
  it('uses the shared selector and emits a saved registration or clear exactly once', async () => {
    using view = mountSelector({ surface: 'settings', modelValue: undefined });
    await flushPromises();
    expect(fixture.reload).toHaveBeenCalledTimes(1);
    expect(view.wrapper.find('select').exists()).toBe(false);
    const selector = view.wrapper.getComponent(SettingsSelect);
    await selector.get('button').trigger('click');
    expect(optionButtons().map(button => button.textContent)).not.toContain('Temporary computer');
    optionButtons().find(button => button.textContent?.includes('Saved computer'))?.click();
    expect(view.wrapper.emitted('update:modelValue')).toEqual([[toNaidanRpcRegistrationId({ raw: 'saved' })]]);
    await view.wrapper.setProps({ modelValue: toNaidanRpcRegistrationId({ raw: 'saved' }) });
    await selector.get('button').trigger('click');
    optionButtons()[0]?.click();
    expect(view.wrapper.emitted('update:modelValue')).toEqual([[toNaidanRpcRegistrationId({ raw: 'saved' })], [undefined]]);
  });

  it('keeps an unknown current registration visible and disabled without rewriting the reference', async () => {
    const unknown = toNaidanRpcRegistrationId({ raw: 'missing-registration' });
    using view = mountSelector({ surface: 'settings', modelValue: unknown });
    await flushPromises();
    const selector = view.wrapper.getComponent(SettingsSelect);
    expect(selector.get('button').text()).toContain('missing-registration');
    await selector.get('button').trigger('click');
    const unknownOption = optionButtons().find(button => button.textContent?.includes('missing-registration'));
    expect(unknownOption?.disabled).toBe(true);
    unknownOption?.click();
    expect(view.wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(view.wrapper.props('modelValue')).toBe(unknown);
  });

  it('refreshes saved registrations from RPC state without replacing an unknown selection', async () => {
    const previous = toNaidanRpcRegistrationId({ raw: 'saved' });
    using view = mountSelector({ surface: 'settings', modelValue: previous });
    await flushPromises();
    fixture.rows = [registration({ rawId: 'new', label: 'New computer', persistence: 'saved' })];
    for (const listener of fixture.listeners) {
      listener();
    }
    await flushPromises();
    const selector = view.wrapper.getComponent(SettingsSelect);
    await selector.get('button').trigger('click');
    expect(optionButtons().find(button => button.textContent?.includes('New computer'))?.disabled).toBe(false);
    expect(optionButtons().find(button => button.textContent?.trim() === 'saved')?.disabled).toBe(true);
    expect(view.wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(view.wrapper.props('modelValue')).toBe(previous);
  });

  it('retains empty and failed states and the management route', async () => {
    fixture.rows = [];
    using view = mountSelector({ surface: 'settings', modelValue: undefined });
    await flushPromises();
    expect(view.wrapper.text()).toContain(lazyStrings.naidanRpc__no_connections());
    fixture.getManager.mockRejectedValueOnce(new Error('Feature unavailable'));
    for (const listener of fixture.listeners) {
      listener();
    }
    await flushPromises();
    expect(view.wrapper.text()).toContain(lazyStrings.naidanRpc__enable_first());
    expect(view.wrapper.emitted('update:modelValue')).toBeUndefined();
    const manager = view.wrapper.findAll('button').find(button => button.text() === lazyStrings.naidanRpc__manage());
    expect(manager).toBeDefined();
    await manager?.trigger('click');
    expect(fixture.push).toHaveBeenCalledWith({ query: { retained: 'value', settings: 'naidan-rpc' } });
  });

  it.each([undefined, 'default'] as const)('keeps the existing native control for surface %s', async surface => {
    const unknown = toNaidanRpcRegistrationId({ raw: 'unknown-native' });
    using view = mountSelector({ surface, modelValue: unknown });
    await flushPromises();
    expect(view.wrapper.findComponent(SettingsSelect).exists()).toBe(false);
    const control = view.wrapper.get<HTMLSelectElement>('[data-testid="rpc-selected-registration"]');
    expect(control.element.value).toBe('unknown-native');
    expect(control.find('option[value="unknown-native"]').attributes('disabled')).toBeDefined();
    expect(control.find('option[value="temporary"]').exists()).toBe(false);
    await control.setValue('saved');
    expect(view.wrapper.emitted('update:modelValue')).toEqual([[toNaidanRpcRegistrationId({ raw: 'saved' })]]);
  });

  it('unsubscribes when unmounted and ignores a late registry result', async () => {
    const reload = Promise.withResolvers<void>();
    fixture.reload.mockReturnValue(reload.promise);
    using view = mountSelector({ surface: 'settings', modelValue: undefined });
    await flushPromises();
    expect(fixture.listeners.size).toBe(1);
    view.wrapper.unmount();
    expect(fixture.listeners.size).toBe(0);
    reload.resolve();
    await flushPromises();
    expect(view.wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
