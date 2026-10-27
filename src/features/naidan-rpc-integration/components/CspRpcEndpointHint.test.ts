import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { toNaidanRpcRegistrationId } from '@/01-models/ids';
import CspRpcEndpointHint from './CspRpcEndpointHint.vue';

const fixture = vi.hoisted(() => ({ read: vi.fn(), listeners: new Set<() => void>(), unsubscribe: vi.fn() }));
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({
  readLoadedRpcRelayForDisplayOnly: fixture.read,
  subscribeRpcState: ({ listener }: { listener(): void }) => {
    fixture.listeners.add(listener);
    return () => {
      fixture.listeners.delete(listener);
      fixture.unsubscribe();
    };
  },
}));
vi.mock('@/components/csp/CspMessageHint.vue', () => ({
  default: { name: 'CspMessageHint', props: ['target', 'presentation', 'activityForDisplayOnly'], template: '<span v-if="target" data-testid="csp-hint" :data-relay="target.url" />' },
}));

const wrappers: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  fixture.read.mockReset();
  fixture.unsubscribe.mockReset();
  fixture.listeners.clear();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
});

it('retains explicit action wording through passive relay lookup without restarting it', async () => {
  const id = toNaidanRpcRegistrationId({ raw: 'one' });
  fixture.read.mockResolvedValue('https://relay.example');
  const wrapper = mount(CspRpcEndpointHint, { props: { activityForDisplayOnly: 'context-summary', registrationId: id, presentation: 'compact' } });
  wrappers.push(wrapper);
  await flushPromises();
  const hint = wrapper.getComponent({ name: 'CspMessageHint' });
  expect(hint.props()).toEqual({ target: { kind: 'relay', url: 'https://relay.example' }, presentation: 'compact', activityForDisplayOnly: 'context-summary' });
  await wrapper.setProps({ activityForDisplayOnly: 'connection' });
  expect(hint.props('activityForDisplayOnly')).toBe('connection');
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith({ registrationId: id });
  expect(wrapper.emitted()).toEqual({});
});

it('stays empty for an uninitialized manager and follows passive state updates', async () => {
  const id = toNaidanRpcRegistrationId({ raw: 'one' });
  const wrapper = mount(CspRpcEndpointHint, { props: { activityForDisplayOnly: undefined, registrationId: id, presentation: 'compact' } });
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.find('[data-testid="csp-hint"]').exists()).toBe(false);
  expect(fixture.read).toHaveBeenCalledWith({ registrationId: id });
  fixture.read.mockResolvedValue('https://relay.example');
  for (const listener of fixture.listeners) {
    listener();
  }
  await flushPromises();
  expect(wrapper.get('[data-testid="csp-hint"]').attributes('data-relay')).toBe('https://relay.example');
});

it('ignores old registration replies and disposes without starting any operation', async () => {
  const old = Promise.withResolvers<string | undefined>();
  fixture.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce('https://second.example');
  const wrapper = mount(CspRpcEndpointHint, { props: { activityForDisplayOnly: undefined, registrationId: toNaidanRpcRegistrationId({ raw: 'one' }), presentation: 'error' } });
  wrappers.push(wrapper);
  await wrapper.setProps({ registrationId: toNaidanRpcRegistrationId({ raw: 'two' }) });
  await flushPromises();
  old.resolve('https://old.example');
  await flushPromises();
  expect(wrapper.get('[data-testid="csp-hint"]').attributes('data-relay')).toBe('https://second.example');
  wrapper.unmount();
  expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  expect(fixture.listeners.size).toBe(0);
});

it('silently removes the optional view when a passive lookup rejects or throws', async () => {
  fixture.read.mockRejectedValueOnce(new Error('Observer failed')).mockImplementationOnce(() => {
    throw new Error('Observer failed');
  });
  const wrapper = mount(CspRpcEndpointHint, { props: { activityForDisplayOnly: undefined, registrationId: toNaidanRpcRegistrationId({ raw: 'one' }), presentation: 'compact' } });
  wrappers.push(wrapper);
  await flushPromises();
  expect(wrapper.find('[data-testid="csp-hint"]').exists()).toBe(false);
  for (const listener of fixture.listeners) {
    listener();
  }
  await flushPromises();
  expect(wrapper.find('[data-testid="csp-hint"]').exists()).toBe(false);
});
