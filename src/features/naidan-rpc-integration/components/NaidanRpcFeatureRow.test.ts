import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import NaidanRpcFeatureRow from './NaidanRpcFeatureRow.vue';
import type { RpcStopStatus } from '@/features/naidan-rpc-integration/runtime/stop-control';

const fixture = vi.hoisted(() => ({ status: 'idle' as RpcStopStatus, request: vi.fn(), listeners: new Set<() => void>(), update: vi.fn() }));
const settings = ref({ experimental: { naidanRpc: 'enabled' as 'enabled' | 'disabled' } });
vi.mock('@/strings', () => ({ lazyStrings: new Proxy({}, { get: (_, key) => () => String(key) }), ensureStrings: new Proxy({}, { get: (_, key) => async () => String(key) }) }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings, updateExperimental: fixture.update }) }));
vi.mock('../runtime/feature', () => ({
  requestRpcStop: fixture.request,
  rpcStopStatus: () => fixture.status,
  subscribeRpcState: ({ listener }: { listener(): void }) => {
    fixture.listeners.add(listener); return () => fixture.listeners.delete(listener);
  },
}));
const wrappers: ReturnType<typeof mount>[] = [];

function panel() {
  const wrapper = mount(NaidanRpcFeatureRow, { global: { stubs: { ExperimentalFeatureRow: defineComponent({ emits: ['toggle'], template: '<button data-testid="toggle" @click="$emit(\'toggle\')">toggle</button>' }) } } });
  wrappers.push(wrapper); return wrapper;
}

function updateStatus({ status }: { status: RpcStopStatus }) {
  fixture.status = status; for (const listener of fixture.listeners) listener();
}

beforeEach(() => {
  vi.clearAllMocks(); settings.value.experimental.naidanRpc = 'enabled'; fixture.status = 'idle'; fixture.update.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount(); fixture.listeners.clear();
});

it('starts the explicit stop independently of a pending settings write', async () => {
  const gate = Promise.withResolvers<void>(); fixture.update.mockReturnValueOnce(gate.promise);
  const wrapper = panel(); await wrapper.get('[data-testid="toggle"]').trigger('click');
  expect(fixture.request).toHaveBeenCalledOnce(); expect(fixture.update).toHaveBeenCalledOnce();
  updateStatus({ status: 'unconfirmed' }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-stop-status"]').text()).toContain('stop_not_confirmed');
  gate.resolve(); await flushPromises(); expect(wrapper.get('[data-testid="rpc-stop-status"]').text()).toContain('stop_not_confirmed');
});

it('shows applied and retired as different statuses and offers a retry only when unconfirmed', async () => {
  const wrapper = panel(); updateStatus({ status: 'applied' }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-stop-status"]').text()).toContain('waiting_for_completion');
  expect(wrapper.find('[data-testid="rpc-retry-stop"]').exists()).toBe(false);
  updateStatus({ status: 'unconfirmed' }); await flushPromises(); await wrapper.get('[data-testid="rpc-retry-stop"]').trigger('click');
  expect(fixture.request).toHaveBeenCalledOnce();
  updateStatus({ status: 'retired' }); await flushPromises(); expect(wrapper.get('[data-testid="rpc-stop-status"]').text()).toContain('rpc_connections_stopped');
});

it('does not send a stop while mounting, enabling, or closing the settings row', async () => {
  settings.value.experimental.naidanRpc = 'disabled'; const wrapper = panel();
  expect(fixture.request).not.toHaveBeenCalled(); await wrapper.get('[data-testid="toggle"]').trigger('click'); await flushPromises();
  expect(fixture.request).not.toHaveBeenCalled(); wrapper.unmount(); expect(fixture.listeners.size).toBe(0);
});
