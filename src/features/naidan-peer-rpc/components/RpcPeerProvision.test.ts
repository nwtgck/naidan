import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import type { NaidanPeerManager, RpcConnectionView } from '@/features/naidan-peer-rpc/runtime/manager';
import type { PeerProvidedMethods } from '@/features/naidan-peer-rpc/contract';
import RpcPeerProvision from './RpcPeerProvision.vue';

const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});
function connection({ id, phase }: { id: string, phase: RpcConnectionView['phase'] }): RpcConnectionView {
  return {
    connection: { id: toNaidanRpcConnectionId({ raw: id }), peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }), autoConnect: 'disabled', localPublicKey: 'A'.repeat(43),
      label: id, transport: { type: 'naidan_piping_duplex', serverUrl: 'https://piping.example', headers: [] }, allowedMethods: [], revision: 0 },
    phase, persistence: 'saved', registryPersistence: 'durable', access: { effective: [], desired: [], saved: [], revision: 0, persistence: 'saved' }, failure: undefined,
  };
}
function panel({ view }: { view: RpcConnectionView }) {
  const getPeerProvidedMethods = vi.fn<NaidanPeerManager['getPeerProvidedMethods']>().mockResolvedValue({ status: 'ready', methods: [] });
  const manager = { getPeerProvidedMethods };
  const wrapper = mount(RpcPeerProvision, { props: { manager, connection: view } }); wrappers.push(wrapper);
  return { wrapper, getPeerProvidedMethods };
}
it('waits for a live connection and queries only its provision metadata', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'disconnected' }) });
  await flushPromises(); expect(getPeerProvidedMethods).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="rpc-peer-provision-refresh"]').element).toHaveProperty('disabled', true);
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  await wrapper.setProps({ connection: connection({ id: 'one', phase: 'connected' }) }); await flushPromises();
  expect(getPeerProvidedMethods).toHaveBeenCalledOnce();
  expect(getPeerProvidedMethods).toHaveBeenCalledWith({ id: toNaidanRpcConnectionId({ raw: 'one' }), signal: expect.any(AbortSignal) });
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
});
it('shows the peer grants independently of this connection offering no inference', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'disconnected' }) });
  getPeerProvidedMethods.mockResolvedValue({ status: 'ready', methods: ['listChatModels', 'generateChat', 'generateImage'] });
  await wrapper.setProps({ connection: connection({ id: 'one', phase: 'connected' }) }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Provided');
  expect(wrapper.get('[data-testid="rpc-peer-images"]').text()).toBe('Partially provided');
});
it('keeps checking and failed queries distinct from no provision and allows retry', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'disconnected' }) });
  getPeerProvidedMethods.mockResolvedValueOnce({ status: 'checking', methods: [] });
  await wrapper.setProps({ connection: connection({ id: 'one', phase: 'connected' }) }); await flushPromises();
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="rpc-peer-provision-status"]').text()).toContain('Checking');
  getPeerProvidedMethods.mockRejectedValueOnce(new Error('Sensitive native failure'));
  await wrapper.get('[data-testid="rpc-peer-provision-refresh"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Sensitive native failure');
  expect(wrapper.get('[data-testid="rpc-peer-provision-status"]').text()).toContain('Could not');
  await wrapper.get('[data-testid="rpc-peer-provision-refresh"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-images"]').text()).toBe('Not provided');
});
it('aborts a superseded query and ignores a late response for a different peer', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'disconnected' }) });
  const old = Promise.withResolvers<PeerProvidedMethods>();
  getPeerProvidedMethods.mockReturnValueOnce(old.promise);
  await wrapper.setProps({ connection: connection({ id: 'one', phase: 'connected' }) });
  const signal = getPeerProvidedMethods.mock.calls[0]![0].signal;
  await wrapper.setProps({ connection: connection({ id: 'two', phase: 'connected' }) }); await flushPromises();
  expect(signal.aborted).toBe(true);
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
  old.resolve({ status: 'ready', methods: ['listChatModels', 'generateChat'] }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
  expect(getPeerProvidedMethods.mock.lastCall?.[0].id).toBe(toNaidanRpcConnectionId({ raw: 'two' }));
});
it('clears confirmed metadata on disconnect and cancels a pending query on unmount', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'connected' }) });
  await flushPromises(); expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(true);
  await wrapper.setProps({ connection: connection({ id: 'one', phase: 'disconnected' }) });
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  const pending = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(pending.promise);
  await wrapper.setProps({ connection: connection({ id: 'one', phase: 'connected' }) });
  const signal = getPeerProvidedMethods.mock.lastCall![0].signal;
  wrapper.unmount(); expect(signal.aborted).toBe(true);
  pending.resolve({ status: 'ready', methods: [] }); await flushPromises();
  window.dispatchEvent(new Event('focus')); expect(getPeerProvidedMethods).toHaveBeenCalledTimes(2);
});
it('rechecks a new connected snapshot for the same ID instead of retaining the previous session result', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'connected' }) });
  await flushPromises();
  const replacement = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(replacement.promise);
  await wrapper.setProps({ connection: connection({ id: 'one', phase: 'connected' }) });
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  expect(getPeerProvidedMethods).toHaveBeenCalledTimes(2);
  replacement.resolve({ status: 'ready', methods: ['listChatModels', 'generateChat'] }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Provided');
});
it('refreshes provision when the window regains focus without repeating a pending query', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'connected' }) });
  await flushPromises();
  const pending = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(pending.promise);
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus'));
  expect(getPeerProvidedMethods).toHaveBeenCalledTimes(2);
  pending.resolve({ status: 'ready', methods: ['listImageModels', 'generateImage'] }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-images"]').text()).toBe('Provided');
});
it('lets an explicit refresh replace a pending query without an arbitrary query deadline', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: connection({ id: 'one', phase: 'connected' }) });
  await flushPromises();
  const pending = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(pending.promise);
  await wrapper.get('[data-testid="rpc-peer-provision-refresh"]').trigger('click');
  const signal = getPeerProvidedMethods.mock.lastCall![0].signal;
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  await wrapper.get('[data-testid="rpc-peer-provision-refresh"]').trigger('click'); await flushPromises();
  expect(signal.aborted).toBe(true); expect(getPeerProvidedMethods).toHaveBeenCalledTimes(3);
  pending.resolve({ status: 'ready', methods: ['listChatModels', 'generateChat'] }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
});
