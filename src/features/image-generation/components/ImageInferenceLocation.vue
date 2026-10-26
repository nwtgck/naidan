<script setup lang="ts">
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import { computed, ref, useId, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { idToRaw } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import ImageSettingsSection from './ImageSettingsSection.vue';
import type { ImageInferenceLocationView } from '@/features/image-generation/composables/use-image-inference-location';

const props = defineProps<{ inferenceLocation: ImageInferenceLocationView, disabled: boolean }>();
const id = useId(), router = useRouter();
const { settings } = useSettings();
const enabled = computed(() => settings.value.experimental?.naidanRpc === 'enabled');
const configuration = ref(''), configurationError = ref('');
const selectedRelay = computed(() => props.inferenceLocation.entries.value.find(entry => entry.registration.id === props.inferenceLocation.registrationId.value && entry.registration.peerPublicKey === props.inferenceLocation.peerPublicKey.value)?.registration.transport.serverUrl);
const modelsRequestRelay = ref<string>();
watch(props.inferenceLocation.selection, value => {
  configuration.value = value ? JSON.stringify(value, undefined, 2) : '';
  configurationError.value = '';
}, { immediate: true });

function chooseKind({ value }: { value: string }): void {
  modelsRequestRelay.value = undefined;
  switch (value) {
  case 'local': case 'naidan_rpc': props.inferenceLocation.setKind({ value });
    break;
  default: throw new Error('Unknown image inference location');
  }
}

function chooseRegistration({ value }: { value: string }): void {
  modelsRequestRelay.value = undefined;
  props.inferenceLocation.chooseRegistration({ id: props.inferenceLocation.entries.value.find(entry => idToRaw({ id: entry.registration.id }) === value)?.registration.id });
}

function requestModels(): Promise<void> {
  // Keep the existing request and promise intact; this snapshot is only a
  // display context for its existing failure message.
  const request = props.inferenceLocation.loadModels();
  modelsRequestRelay.value = props.inferenceLocation.loading.value ? selectedRelay.value : undefined;
  return request;
}

function refreshConnections(): Promise<void> {
  modelsRequestRelay.value = undefined;
  return props.inferenceLocation.refresh({ fromStorage: true });
}

function applyConfiguration(): void {
  if (props.disabled) {
    return;
  }
  try {
    if (configuration.value.length > 65536) {
      throw new Error('The model configuration is too large');
    }
    props.inferenceLocation.selectModel({ value: JSON.parse(configuration.value) });
    configurationError.value = '';
  } catch (error) {
    configurationError.value = error instanceof Error ? error.message : String(error);
  }
}

function manage(): void {
  void router.push({ query: { ...router.currentRoute.value.query, settings: 'naidan-rpc' } });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-3" data-testid="image-inference-location">
    <label :for="id + '-inference-location'" tw-class="block text-xs font-semibold">{{ lazyStrings.ImageInferenceLocation__compute_with() }}</label>
    <SettingsFormSelect :id="id + '-inference-location'" :model-value="inferenceLocation.kind.value" @update:model-value="chooseKind({ value: $event })" :disabled="disabled" data-testid="image-inference-location-kind" :label="lazyStrings.ImageInferenceLocation__compute_with()" :options="[{ value: 'local', label: lazyStrings.ImageInferenceLocation__this_device() }, ...(enabled ? [{ value: 'naidan_rpc', label: 'Naidan RPC' }] : inferenceLocation.kind.value === 'naidan_rpc' ? [{ value: 'naidan_rpc', label: lazyStrings.naidanRpc__disabled(), disabled: true }] : [])]" />
    <template v-if="inferenceLocation.kind.value === 'naidan_rpc'">
      <label :for="id + '-registration'" tw-class="block text-xs font-semibold">{{ lazyStrings.naidanRpc__choose_connection() }}</label>
      <SettingsFormSelect :id="id + '-registration'" :model-value="inferenceLocation.registrationKey.value" :disabled="disabled" @update:model-value="chooseRegistration({ value: $event })" data-testid="image-inference-location-registration" :label="lazyStrings.naidanRpc__choose_connection()" :options="[{ value: '', label: lazyStrings.naidanRpc__choose_connection() }, ...inferenceLocation.entries.value.map(entry => ({ value: idToRaw({ id: entry.registration.id }), label: entry.registration.label })), ...(inferenceLocation.registrationId.value && !inferenceLocation.entries.value.some(entry => entry.registration.id === inferenceLocation.registrationId.value) ? [{ value: inferenceLocation.registrationKey.value, label: inferenceLocation.label.value || inferenceLocation.registrationKey.value, disabled: true }] : [])]" />
      <p v-if="!enabled" role="status" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ lazyStrings.naidanRpc__enable_first() }}</p>
      <p v-else-if="!inferenceLocation.connected.value" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.ImageInferenceLocation__connect_in_rpc_settings() }}</p>
      <div tw-class="flex flex-wrap gap-3">
        <button type="button" @click="manage" tw-class="text-xs font-semibold text-blue-600 dark:text-blue-400">{{ lazyStrings.naidanRpc__manage() }}</button>
        <button type="button" @click="refreshConnections" :disabled="disabled" data-testid="image-inference-location-refresh" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageInferenceLocation__refresh_connections() }}</button>
        <button type="button" @click="requestModels" :disabled="disabled || !inferenceLocation.connected.value || inferenceLocation.loading.value" data-testid="image-inference-location-models" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageInferenceLocation__list_remote_models() }}</button>
      </div>
      <CspMessageHint activity-for-display-only="model-list" :target="{ kind: 'relay', url: selectedRelay }" presentation="compact" />
      <p v-if="inferenceLocation.selection.value" tw-class="text-xs break-all" data-testid="image-inference-location-selected-model">{{ inferenceLocation.selection.value.primary.file.location.path }}</p>
      <ImageSettingsSection compact :title="lazyStrings.ImageInferenceLocation__explicit_model_configuration()" :summary="undefined">
        <textarea v-model="configuration" :aria-label="lazyStrings.ImageInferenceLocation__explicit_model_configuration()" rows="6" maxlength="65536" :disabled="disabled" data-testid="image-inference-location-configuration" tw-class="mt-2 block w-full rounded-lg border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-3 text-xs leading-6 font-mono outline-none transition-colors focus:border-blue-400/60 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-45" />
        <button type="button" @click="applyConfiguration" :disabled="disabled" data-testid="image-inference-location-apply-configuration" tw-class="mt-2 text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageInferenceLocation__use_configuration() }}</button>
        <p v-if="configurationError" role="alert" tw-class="text-xs text-red-600 break-words">{{ configurationError }}</p>
      </ImageSettingsSection>
      <!-- Choosing existing files for one request is not provider-side model
           management. Download/import/delete and settings writes are deliberately
           not offered by this RPC surface. -->
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageInferenceLocation__remote_models_are_read_only() }}</p>
      <p v-if="inferenceLocation.failure.value" role="alert" tw-class="text-xs text-red-600 break-words">{{ inferenceLocation.failure.value }}</p>
      <CspMessageHint activity-for-display-only="model-list" v-if="inferenceLocation.failure.value && inferenceLocation.connected.value && modelsRequestRelay !== undefined && modelsRequestRelay === selectedRelay" :target="{ kind: 'relay', url: modelsRequestRelay }" presentation="error" />
    </template>
  </section>
</template>
