import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import NaidanRpcTab from './NaidanRpcTab.vue';
import type { RpcConnectionView, NaidanPeerManager } from '@/features/naidan-peer-rpc/runtime/manager';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';

const fixture = vi.hoisted(() => ({
  rows: [] as RpcConnectionView[],
  reload: vi.fn(),
  pair: vi.fn(),
  remember: vi.fn(),
  updateAllowedMethods: vi.fn(),
  confirm: vi.fn(),
  connect: vi.fn(),
  setAutoConnect: vi.fn(),
  getPeerProvidedMethods: vi.fn(),
  prepareDisconnect: vi.fn(),
  disconnect: vi.fn(),
  cancelPairing: vi.fn(),
  rename: vi.fn(),
  edit: vi.fn(),
  forget: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock('@/strings', () => ({ lazyStrings: new Proxy({}, { get: (_, name) => () => String(name) }), ensureStrings: new Proxy({}, { get: (_, name) => async () => String(name) }) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: fixture.confirm }) }));
vi.mock('../runtime/feature', () => ({
  getRpcManager: async () => ({ ...fixture, list: () => fixture.rows }),
  subscribeRpcState: ({ listener }: { listener(): void }) => {
    fixture.listeners.add(listener); return () => fixture.listeners.delete(listener);
  },
}));
const wrappers: ReturnType<typeof mount>[] = [];
function panel() {
  const wrapper = mount(NaidanRpcTab); wrappers.push(wrapper); return wrapper;
}
const id = toNaidanRpcConnectionId({ raw: 'connection-1' });
function row({ phase = 'connected', persistence = 'temporary' }: { phase?: RpcConnectionView['phase'], persistence?: RpcConnectionView['persistence'] } = {}): RpcConnectionView {
  return {
    connection: {
      id,
      peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }),
      autoConnect: 'disabled',
      localPublicKey: 'A'.repeat(43),
      label: 'Peer 1234',
      transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.example', headers: [{ name: 'Authorization', value: 'private-token' }] },
      allowedMethods: [],
      revision: 0,
    },
    phase,
    persistence,
    registryPersistence: persistence === 'saved' ? 'durable' : undefined,
    access: { effective: [], desired: [], saved: [], revision: 0, persistence },
    failure: undefined,
    health: undefined,
    session: phase === 'connected' ? {} : undefined,
  };
}
beforeEach(() => {
  fixture.rows = []; vi.clearAllMocks(); fixture.reload.mockResolvedValue(undefined); fixture.connect.mockResolvedValue(undefined);
  fixture.confirm.mockResolvedValue(true);
  fixture.getPeerProvidedMethods.mockResolvedValue({ status: 'ready', methods: [] });
  fixture.prepareDisconnect.mockImplementation(({ id }: { id: Parameters<NaidanPeerManager['disconnect']>[0]['id'] }) => () => fixture.disconnect({ id }));
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount(); fixture.listeners.clear();
});
it('opens the pairing form for an empty registry without pairing, connecting or remembering a peer', async () => {
  const wrapper = panel(); await flushPromises(); expect(wrapper.find('[data-testid="naidan-rpc-tab"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="rpc-code"]').exists()).toBe(true);
  expect(wrapper.find('select').exists()).toBe(false);
  expect(wrapper.get('[data-testid="rpc-start"]').element).toHaveProperty('disabled', true);
  expect(fixture.reload).toHaveBeenCalledOnce(); expect(fixture.pair).not.toHaveBeenCalled(); expect(fixture.connect).not.toHaveBeenCalled(); expect(fixture.remember).not.toHaveBeenCalled();
});
it('waits for the registry to load before opening the empty pairing form', async () => {
  const loading = Promise.withResolvers<void>();
  fixture.reload.mockReturnValueOnce(loading.promise);
  const wrapper = panel(); await flushPromises();
  expect(wrapper.find('[data-testid="rpc-code"]').exists()).toBe(false);
  loading.resolve(); await flushPromises();
  expect(wrapper.find('[data-testid="rpc-code"]').exists()).toBe(true);
  expect(fixture.pair).not.toHaveBeenCalled(); expect(fixture.connect).not.toHaveBeenCalled();
});
it('does not treat a failed registry load as an empty registry', async () => {
  fixture.reload.mockRejectedValueOnce(new Error('Storage unavailable'));
  const wrapper = panel(); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe('naidanRpc__failed');
  expect(wrapper.find('[data-testid="rpc-code"]').exists()).toBe(false);
  expect(fixture.pair).not.toHaveBeenCalled(); expect(fixture.connect).not.toHaveBeenCalled();
});
it('preserves an open pairing form when the registry is refreshed', async () => {
  const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-code"]').setValue('0042');
  await wrapper.get('[data-testid="rpc-server"]').setValue('https://new.example');
  fixture.rows = [row({ persistence: 'saved' })];
  await wrapper.get('[data-testid="rpc-refresh"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-code"]').element).toHaveProperty('value', '0042');
  expect(wrapper.get('[data-testid="rpc-server"]').element).toHaveProperty('value', 'https://new.example');
  expect(fixture.reload).toHaveBeenCalledTimes(2);
  expect(fixture.pair).not.toHaveBeenCalled(); expect(fixture.connect).not.toHaveBeenCalled();
});
it('requires no display name or trust choice before first comparison, then offers remembering', async () => {
  fixture.pair.mockImplementation(async (args: Parameters<NaidanPeerManager['pair']>[0]) => {
    const approved = await args.verifyPeer({ comparison: new Uint8Array(32).map((_, i) => i), peerIdentity: new Uint8Array(32).fill(2), signal: new AbortController().signal });
    if (!approved) throw new Error('rejected'); fixture.rows = [row()]; return id;
  });
  const wrapper = panel(); await flushPromises(); await wrapper.get('[data-testid="rpc-new"]').trigger('click');
  expect(wrapper.find('[data-testid="rpc-remember-card"]').exists()).toBe(false);
  await wrapper.get('[data-testid="rpc-code"]').setValue('家のPC 🔌'); await wrapper.get('[data-testid="rpc-server"]').setValue('https://relay.example');
  await wrapper.get('[data-testid="rpc-start"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-comparison"]').text().replaceAll(' ', '')).toBe(Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''));
  expect(fixture.remember).not.toHaveBeenCalled(); await wrapper.get('[data-testid="rpc-approve"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[data-testid="rpc-remember-card"]').exists()).toBe(true); expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
  expect(fixture.pair.mock.calls[0]![0].code).toBe('家のPC 🔌');
  await wrapper.get('[data-testid="rpc-remember"]').trigger('click'); await flushPromises(); expect(fixture.remember).toHaveBeenCalledWith({ id, label: 'Peer 1234' });
});
it('keeps partial method grants when the panel opens and details are collapsed', async () => {
  const partial = row({ persistence: 'saved' }); partial.access.effective = ['generateChat'];
  fixture.rows = [partial]; const wrapper = panel(); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-provide-chat"]').element).toHaveProperty('checked', true);
  expect(wrapper.find('[data-testid="rpc-partial-chat"]').exists()).toBe(true);
  expect(wrapper.get('[data-testid="rpc-details-chat"]').element).toHaveProperty('open', false);
  expect(wrapper.get('[data-testid="rpc-method-listChatModels"]').element).toHaveProperty('checked', false);
  expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
});
it('toggles chat and image capabilities independently with concrete method lists', async () => {
  fixture.rows = [row({ persistence: 'saved' })]; const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-provide-chat"]').setValue(true);
  expect(wrapper.get('[data-testid="rpc-provide-images"]').element).toHaveProperty('checked', false);
  expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="rpc-apply-methods"]').trigger('click'); await flushPromises();
  if (__BUILD_MODE_IS_HOSTED__) expect(fixture.updateAllowedMethods).toHaveBeenLastCalledWith({ id, allowedMethods: ['listChatModels', 'generateChat'] });
  else expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="rpc-provide-chat"]').setValue(false);
  await wrapper.get('[data-testid="rpc-provide-images"]').setValue(true);
  await wrapper.get('[data-testid="rpc-apply-methods"]').trigger('click'); await flushPromises();
  if (__BUILD_MODE_IS_HOSTED__) expect(fixture.updateAllowedMethods).toHaveBeenLastCalledWith({ id, allowedMethods: ['listImageModels', 'generateImage'] });
  else expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
});
it('respects native provision availability when applying concrete methods', async () => {
  fixture.rows = [row()]; const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-method-listChatModels"]').setValue(true);
  expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
  const apply = wrapper.get('[data-testid="rpc-apply-methods"]');
  expect(apply.element).toHaveProperty('disabled', !__BUILD_MODE_IS_HOSTED__);
  await apply.trigger('click'); await flushPromises();
  if (__BUILD_MODE_IS_HOSTED__) expect(fixture.updateAllowedMethods).toHaveBeenCalledWith({ id, allowedMethods: ['listChatModels'] });
  else expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
});
it('masks header values and closing Settings does not disconnect an established peer', async () => {
  fixture.rows = [row({ persistence: 'saved' })]; const wrapper = panel(); await flushPromises();
  expect(wrapper.text()).not.toContain('private-token'); expect(wrapper.find('input[type="password"]').exists()).toBe(true);
  wrapper.unmount(); expect(fixture.disconnect).not.toHaveBeenCalled();
});
it('allows stopping while an explicit connection command is still pending', async () => {
  fixture.rows = [row({ persistence: 'saved', phase: 'disconnected' })]; const gate = Promise.withResolvers<void>(); fixture.connect.mockImplementation(() => {
    fixture.rows[0]!.phase = 'connecting'; for (const listener of fixture.listeners) listener(); return gate.promise;
  });
  const wrapper = panel(); await flushPromises(); await wrapper.get('[data-testid="rpc-connect"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-testid="rpc-disconnect"]').trigger('click'); await flushPromises(); expect(fixture.disconnect).toHaveBeenCalledWith({ id }); gate.resolve(); await flushPromises();
});

it('renames a saved connected peer without editing transport or reconnecting', async () => {
  fixture.rows = [row({ persistence: 'saved' })];
  const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-name"]').setValue('Desk');
  await wrapper.get('[data-testid="rpc-save-name"]').trigger('click'); await flushPromises();
  expect(fixture.rename).toHaveBeenCalledWith({ id, label: 'Desk' });
  expect(fixture.edit).not.toHaveBeenCalled(); expect(fixture.connect).not.toHaveBeenCalled(); expect(fixture.disconnect).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="rpc-server"]').element).toHaveProperty('disabled', false);
  expect(wrapper.get('[data-testid="rpc-server"]').element.closest('fieldset')?.disabled).toBe(true);
});

it('rebinds all editable fields when the selected connection disappears', async () => {
  const old = row({ persistence: 'saved', phase: 'disconnected' });
  old.connection.label = 'Removed peer';
  old.access.effective = ['generateChat'];
  const replacement = row({ persistence: 'saved', phase: 'disconnected' });
  replacement.connection = {
    ...replacement.connection,
    id: toNaidanRpcConnectionId({ raw: 'connection-2' }),
    label: 'Other peer',
    transport: { ...replacement.connection.transport, serverUrl: 'https://other.example', headers: [] },
  };
  fixture.rows = [old, replacement];
  const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-method-generateImage"]').setValue(true);
  fixture.rows = [replacement];
  for (const listener of fixture.listeners) listener();
  await flushPromises();
  expect(wrapper.get('[data-testid="rpc-name"]').element).toHaveProperty('value', 'Other peer');
  expect(wrapper.get('[data-testid="rpc-server"]').element).toHaveProperty('value', 'https://other.example');
  expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  const apply = wrapper.get('[data-testid="rpc-apply-methods"]');
  expect(apply.element).toHaveProperty('disabled', !__BUILD_MODE_IS_HOSTED__);
  await apply.trigger('click'); await flushPromises();
  if (__BUILD_MODE_IS_HOSTED__) expect(fixture.updateAllowedMethods).toHaveBeenCalledWith({ id: replacement.connection.id, allowedMethods: [] });
  else expect(fixture.updateAllowedMethods).not.toHaveBeenCalled();
});
it('keeps edits for the same connection across unrelated state notifications', async () => {
  fixture.rows = [row({ persistence: 'saved', phase: 'disconnected' })];
  const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-name"]').setValue('Unsaved name');
  await wrapper.get('[data-testid="rpc-method-generateImage"]').setValue(true);
  for (const listener of fixture.listeners) listener();
  await flushPromises();
  expect(wrapper.get('[data-testid="rpc-name"]').element).toHaveProperty('value', 'Unsaved name');
  expect(wrapper.get('[data-testid="rpc-method-generateImage"]').element).toHaveProperty('checked', true);
});
it('does not replace a new pairing form with a surviving registered connection', async () => {
  fixture.rows = [row({ persistence: 'saved' })];
  const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-new"]').trigger('click');
  await wrapper.get('[data-testid="rpc-code"]').setValue('0042');
  await wrapper.get('[data-testid="rpc-server"]').setValue('https://new.example');
  fixture.rows = [];
  for (const listener of fixture.listeners) listener();
  await flushPromises();
  expect(wrapper.get('[data-testid="rpc-code"]').element).toHaveProperty('value', '0042');
  expect(wrapper.get('[data-testid="rpc-server"]').element).toHaveProperty('value', 'https://new.example');
});
it('captures the session-specific stop command before awaiting confirmation', async () => {
  fixture.rows = [row({ persistence: 'saved' })];
  const confirmation = Promise.withResolvers<boolean>();
  fixture.confirm.mockReturnValue(confirmation.promise);
  const prepared = vi.fn(async () => {});
  fixture.prepareDisconnect.mockReturnValue(prepared);
  const wrapper = panel(); await flushPromises();
  await wrapper.get('[data-testid="rpc-disconnect"]').trigger('click'); await flushPromises();
  expect(fixture.prepareDisconnect).toHaveBeenCalledWith({ id });
  expect(prepared).not.toHaveBeenCalled();
  confirmation.resolve(true); await flushPromises();
  expect(prepared).toHaveBeenCalledOnce(); expect(fixture.disconnect).not.toHaveBeenCalled();
});
it.each(['temporary', 'session'] as const)('keeps automatic connection visible but unavailable for a %s record', async variant => {
  const view = row({ persistence: variant === 'temporary' ? 'temporary' : 'saved' });
  if (variant === 'session') view.registryPersistence = 'session';
  fixture.rows = [view]; const wrapper = panel(); await flushPromises();
  expect(wrapper.get('[data-testid="rpc-auto-connect"]').element).toHaveProperty('disabled', true);
  expect(fixture.setAutoConnect).not.toHaveBeenCalled();
});
it('shows only committed automatic intent when saving it fails', async () => {
  fixture.rows = [row({ persistence: 'saved' })]; fixture.setAutoConnect.mockRejectedValueOnce(new Error('quota'));
  const wrapper = panel(); await flushPromises(); await wrapper.get('[data-testid="rpc-auto-connect"]').setValue(true); await flushPromises();
  expect(fixture.setAutoConnect).toHaveBeenCalledWith({ id, autoConnect: 'enabled' });
  expect(wrapper.get('[data-testid="rpc-auto-connect"]').element).toHaveProperty('checked', false);
  expect(wrapper.get('[role="alert"]').text()).toBe('naidanRpc__failed');
});
