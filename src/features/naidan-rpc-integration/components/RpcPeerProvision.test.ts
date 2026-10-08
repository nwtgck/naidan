import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import type { NaidanPeerManager, RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import { describePeerMethods } from '@/features/naidan-rpc-integration/contract';
import type { PeerProvidedMethods } from '@/features/naidan-rpc-integration/contract';
import RpcPeerProvision from './RpcPeerProvision.vue';

const wrappers: ReturnType<typeof mount>[] = [];

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

function registration({ id, phase }: { id: string, phase: RpcRegistrationView['phase'] }): RpcRegistrationView {
  return {
    registration: {
      id: toNaidanRpcRegistrationId({ raw: id }),
      peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) }),
      connectOnStartup: 'disabled',
      localPublicKey: 'A'.repeat(43),
      label: id,
      transport: { type: 'naidan_piping_duplex', serverUrl: 'https://piping.example', headers: [] },
      inboundAllowedMethods: [],
      revision: 0,
    },
    phase,
    desiredConnection: phase === 'disconnected' ? 'disconnected' : 'connected',
    recoveryStatus: 'ready',
    persistence: 'saved',
    registryPersistence: 'durable',
    access: { effective: [], desired: [], saved: [], revision: 0, persistence: 'saved' },
    failure: undefined,
    connectionToken: phase === 'connected' ? {} : undefined,
  };
}
function panel({ view }: { view: RpcRegistrationView }) {
  const getPeerProvidedMethods = vi.fn<NaidanPeerManager['getPeerProvidedMethods']>().mockResolvedValue({ status: 'ready', methods: [] });
  const manager = { getPeerProvidedMethods };
  const wrapper = mount(RpcPeerProvision, { props: { manager, registration: view } }); wrappers.push(wrapper);
  return { wrapper, getPeerProvidedMethods };
}

it('waits for a live connection and queries only its provision metadata', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'disconnected' }) });
  await flushPromises(); expect(getPeerProvidedMethods).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="rpc-peer-provision-refresh"]').element).toHaveProperty('disabled', true);
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  await wrapper.setProps({ registration: registration({ id: 'one', phase: 'connected' }) }); await flushPromises();
  expect(getPeerProvidedMethods).toHaveBeenCalledOnce();
  expect(getPeerProvidedMethods).toHaveBeenCalledWith({ id: toNaidanRpcRegistrationId({ raw: 'one' }), signal: expect.any(AbortSignal) });
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
});

it('shows the peer grants independently of this registration offering no inference', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'disconnected' }) });
  getPeerProvidedMethods.mockResolvedValue({ status: 'ready', methods: describePeerMethods({ names: ['listChatModels', 'generateChat', 'generateImage'] }) });
  await wrapper.setProps({ registration: registration({ id: 'one', phase: 'connected' }) }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Provided');
  expect(wrapper.get('[data-testid="rpc-peer-images"]').text()).toBe('Partially provided');
});

it('keeps checking and failed queries distinct from no provision and allows retry', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'disconnected' }) });
  getPeerProvidedMethods.mockResolvedValueOnce({ status: 'checking', methods: [] });
  await wrapper.setProps({ registration: registration({ id: 'one', phase: 'connected' }) }); await flushPromises();
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
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'disconnected' }) });
  const old = Promise.withResolvers<PeerProvidedMethods>();
  getPeerProvidedMethods.mockReturnValueOnce(old.promise);
  await wrapper.setProps({ registration: registration({ id: 'one', phase: 'connected' }) });
  const signal = getPeerProvidedMethods.mock.calls[0]![0].signal;
  await wrapper.setProps({ registration: registration({ id: 'two', phase: 'connected' }) }); await flushPromises();
  expect(signal.aborted).toBe(true);
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
  old.resolve({ status: 'ready', methods: describePeerMethods({ names: ['listChatModels', 'generateChat'] }) }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
  expect(getPeerProvidedMethods.mock.lastCall?.[0].id).toBe(toNaidanRpcRegistrationId({ raw: 'two' }));
});

it('clears confirmed metadata on disconnect and cancels a pending query on unmount', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'connected' }) });
  await flushPromises(); expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(true);
  await wrapper.setProps({ registration: registration({ id: 'one', phase: 'disconnected' }) });
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  const pending = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(pending.promise);
  await wrapper.setProps({ registration: registration({ id: 'one', phase: 'connected' }) });
  const signal = getPeerProvidedMethods.mock.lastCall![0].signal;
  wrapper.unmount(); expect(signal.aborted).toBe(true);
  pending.resolve({ status: 'ready', methods: [] }); await flushPromises();
  window.dispatchEvent(new Event('focus')); expect(getPeerProvidedMethods).toHaveBeenCalledTimes(2);
});

it('rechecks a new connected snapshot for the same ID instead of retaining the previous session result', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'connected' }) });
  await flushPromises();
  const replacement = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(replacement.promise);
  await wrapper.setProps({ registration: registration({ id: 'one', phase: 'connected' }) });
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  expect(getPeerProvidedMethods).toHaveBeenCalledTimes(2);
  replacement.resolve({ status: 'ready', methods: describePeerMethods({ names: ['listChatModels', 'generateChat'] }) }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Provided');
});

it('refreshes provision when the window regains focus without repeating a pending query', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'connected' }) });
  await flushPromises();
  const pending = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(pending.promise);
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus'));
  expect(getPeerProvidedMethods).toHaveBeenCalledTimes(2);
  pending.resolve({ status: 'ready', methods: describePeerMethods({ names: ['listImageModels', 'generateImage'] }) }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-images"]').text()).toBe('Provided');
});

it('lets an explicit refresh replace a pending query without an arbitrary query deadline', async () => {
  const { wrapper, getPeerProvidedMethods } = panel({ view: registration({ id: 'one', phase: 'connected' }) });
  await flushPromises();
  const pending = Promise.withResolvers<PeerProvidedMethods>(); getPeerProvidedMethods.mockReturnValueOnce(pending.promise);
  await wrapper.get('[data-testid="rpc-peer-provision-refresh"]').trigger('click');
  const signal = getPeerProvidedMethods.mock.lastCall![0].signal;
  expect(wrapper.find('[data-testid="rpc-peer-chat"]').exists()).toBe(false);
  await wrapper.get('[data-testid="rpc-peer-provision-refresh"]').trigger('click'); await flushPromises();
  expect(signal.aborted).toBe(true); expect(getPeerProvidedMethods).toHaveBeenCalledTimes(3);
  pending.resolve({ status: 'ready', methods: describePeerMethods({ names: ['listChatModels', 'generateChat'] }) }); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
});

it('does not query again for local-setting snapshots of the same live session', async () => {
  const view = registration({ id: 'one', phase: 'connected' });
  const { wrapper, getPeerProvidedMethods } = panel({ view }); await flushPromises();
  await wrapper.setProps({ registration: { ...view, registration: { ...view.registration, label: 'Desk' } } }); await flushPromises();
  expect(getPeerProvidedMethods).toHaveBeenCalledOnce(); expect(wrapper.get('[data-testid="rpc-peer-chat"]').text()).toBe('Not provided');
});
