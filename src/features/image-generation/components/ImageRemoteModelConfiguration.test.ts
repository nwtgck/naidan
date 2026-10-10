import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toBinaryObjectId, toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import { createImageForm } from '@/features/image-generation/form';
import { useImageInferenceLocation } from '@/features/image-generation/composables/use-image-inference-location';
import { remoteImageFileKey } from '@/features/image-generation/remote-image-model-editor';
import ImageRemoteModelConfiguration from './ImageRemoteModelConfiguration.vue';
import ImageModelPicker from '@/features/stable-diffusion-cpp-browser/components/ImageModelPicker.vue';

vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({ subscribeRpcState: () => () => {}, getRpcManager: vi.fn() }));
let wrapper: VueWrapper | undefined, scope: ReturnType<typeof effectScope> | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount(); scope?.stop();
});

function harness() {
  scope = effectScope();
  const form = createImageForm({ profile: 'webgpu-wasm32-asyncify' });
  const inferenceLocation = scope.run(() => useImageInferenceLocation({ form, blocked: () => false, identifyInput: () => toBinaryObjectId({ raw: 'input-image' }) }))!;
  const registrationId = toNaidanRpcRegistrationId({ raw: 'connection-one' }), peerPublicKey = toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) });
  inferenceLocation.restorePreferences({ inferenceLocation: { kind: 'naidan_rpc', registration: { registrationId, peerPublicKey } }, remoteModelEditors: [] });
  const main = { location: { kind: 'opfs' as const, path: 'models/main.gguf' } }, vae = { location: { kind: 'opfs' as const, path: 'models/vae.gguf' } }, lora = { location: { kind: 'host' as const, directoryId: 'peer-root', path: 'adapter.gguf' } };
  inferenceLocation.catalog.value = [
    { label: 'main', file: main, roles: ['diffusion'], facts: { family: 'z-image', classes: [] } },
    { label: 'vae', file: vae, roles: ['vae'], facts: { family: 'unknown', classes: ['vae-flux16'] } },
    { label: 'adapter', file: lora, roles: ['lora'] },
  ];
  inferenceLocation.choosePrimary({ id: remoteImageFileKey({ file: main }) });
  wrapper = mount(ImageRemoteModelConfiguration, { props: { inferenceLocation, disabled: false, active: true } });
  return { inferenceLocation, form, vae, lora, wrapper };
}

it('uses the normal component picker to select a remote VAE without creating local model Files', async () => {
  const h = harness();
  h.wrapper.findAllComponents(ImageModelPicker).find(picker => picker.attributes('data-testid') === 'image-component-vae')!.vm.$emit('update:modelValue', remoteImageFileKey({ file: h.vae }));
  await flushPromises();
  expect(h.inferenceLocation.editor.value.components).toEqual([{ slot: 'vae', file: h.vae }]); expect(h.form.files.value).toEqual({});
});

it('provides the same adapter enable, strength and remove operations for remote references', async () => {
  const h = harness();
  h.wrapper.findAllComponents(ImageModelPicker).find(picker => picker.attributes('data-testid') === 'image-lora-saved')!.vm.$emit('update:modelValue', remoteImageFileKey({ file: h.lora }));
  await flushPromises(); await h.wrapper.get('[data-testid="image-lora-add-saved"]').trigger('click');
  await h.wrapper.get('[data-testid="image-lora-strength"]').setValue('0.6');
  await h.wrapper.get('[data-testid="image-lora-enabled"]').setValue(false);
  expect(h.inferenceLocation.editor.value.loras).toEqual([{ file: h.lora, strength: 0.6, enabled: 'disabled' }]);
  expect(h.inferenceLocation.selection.value?.loras).toEqual([]);
  expect(h.wrapper.get('[data-testid="image-lora-strength"]').element.matches(':disabled')).toBe(true);
  await h.wrapper.get('[data-testid="image-lora-remove"]').trigger('click'); expect(h.inferenceLocation.editor.value.loras).toEqual([]);
});
