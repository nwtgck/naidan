import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { toBinaryObjectId, toNaidanRpcPeerPublicKey, toNaidanRpcRegistrationId } from '@/01-models/ids';
import type { RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import { createImageForm } from '@/features/image-generation/form';
import { useImageInferenceLocation } from '@/features/image-generation/composables/use-image-inference-location';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageInferenceLocation from './ImageInferenceLocation.vue';

const fixture = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn() }));
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({ getRpcManager: fixture.get, subscribeRpcState: () => () => {} }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: fixture.push, currentRoute: { value: { query: {} } } }) }));
vi.mock('@/composables/useSettings', async () => {
  const { ref } = await import('vue');
  return { useSettings: () => ({ settings: ref({ experimental: { naidanRpc: 'enabled' } }) }) };
});
vi.mock('@/components/csp/CspMessageHint.vue', () => ({
  default: { props: ['target', 'presentation', 'activityForDisplayOnly'], template: '<span v-if="target?.url" data-testid="csp-hint" :data-presentation="presentation" :data-activity="activityForDisplayOnly" :data-relay="target.url" />' },
}));

const cleanups: (() => void)[] = [];

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  fixture.get.mockReset();
  fixture.push.mockReset();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function registration(): RpcRegistrationView {
  return {
    registration: {
      id: toNaidanRpcRegistrationId({ raw: 'image-peer' }),
      peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) }),
      localPublicKey: 'A'.repeat(43),
      label: 'Image peer',
      transport: { type: 'naidan_piping_duplex', serverUrl: 'https://image-relay.example', headers: [] },
      inboundAllowedMethods: [],
      connectOnStartup: 'disabled',
      revision: 0,
    },
    phase: 'connected',
    desiredConnection: 'connected',
    recoveryStatus: 'ready',
    health: undefined,
    persistence: 'saved',
    registryPersistence: 'durable',
    access: { effective: [], desired: [], saved: [], revision: 0, persistence: 'saved' },
    failure: undefined,
    connectionToken: {},
  };
}

async function panel() {
  const row = registration();
  const reload = vi.fn(async () => {}), listImageModels = vi.fn();
  const bindClient = vi.fn(() => ({ registration: row.registration, signal: new AbortController().signal, client: { listImageModels } }));
  fixture.get.mockResolvedValue({ reload, list: () => [row], bindClient });
  const scope = effectScope();
  cleanups.push(() => scope.stop());
  const location = scope.run(() => useImageInferenceLocation({ form: createImageForm({ profile: 'webgpu-wasm32-asyncify' }), blocked: () => false, identifyInput: () => toBinaryObjectId({ raw: 'image-input' }) }));
  if (location === undefined) {
    throw new Error('The test scope is inactive');
  }
  location.setKind({ value: 'naidan_rpc' });
  await flushPromises();
  location.chooseRegistration({ id: row.registration.id });
  const wrapper = mount(ImageInferenceLocation, { props: { inferenceLocation: location, disabled: false } });
  cleanups.unshift(() => wrapper.unmount());
  return { row, location, wrapper, reload, listImageModels, bindClient };
}

it('keeps remote model listing and retry available while adding its relay context', async () => {
  const state = await panel();
  const result = Promise.withResolvers<ReadableStream<never>>();
  state.listImageModels.mockReturnValue({ result: result.promise, closed: Promise.resolve(), cancel: vi.fn() });
  await state.wrapper.get('[data-testid="image-inference-location-models"]').trigger('click');
  await flushPromises();
  result.reject(new TypeError('Remote catalog failed'));
  await flushPromises();
  expect(state.listImageModels).toHaveBeenCalledOnce();
  expect(state.bindClient).toHaveBeenCalledOnce();
  expect(state.wrapper.get('[data-testid="csp-hint"][data-presentation="error"]').attributes('data-relay')).toBe('https://image-relay.example');
  expect(state.wrapper.get('[data-testid="csp-hint"][data-presentation="error"]').attributes('data-activity')).toBe('model-list');
  expect(state.wrapper.get('[data-testid="image-inference-location-models"]').element).toHaveProperty('disabled', false);
});

it('does not present a local registry failure as a model request failure', async () => {
  const state = await panel();
  state.reload.mockRejectedValueOnce(new Error('Local registry is unavailable'));
  await state.wrapper.get('[data-testid="image-inference-location-refresh"]').trigger('click');
  await flushPromises();
  expect(state.wrapper.get('[role="alert"]').text()).toBe('Local registry is unavailable');
  expect(state.wrapper.find('[data-testid="csp-hint"][data-presentation="error"]').exists()).toBe(false);
  expect(state.listImageModels).not.toHaveBeenCalled();
});

it('does not borrow a relay from a changed remote identity', async () => {
  const state = await panel();
  state.location.entries.value = [{ ...state.row, registration: { ...state.row.registration, peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'C'.repeat(43) }) } }];
  await flushPromises();
  expect(state.wrapper.find('[data-testid="csp-hint"]').exists()).toBe(false);
  expect(state.wrapper.get('[data-testid="image-inference-location-models"]').element).toHaveProperty('disabled', true);
  expect(state.listImageModels).not.toHaveBeenCalled();
});
