<script setup lang="ts">
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
watch(props.inferenceLocation.selection, value => {
  configuration.value = value ? JSON.stringify(value, undefined, 2) : ''; configurationError.value = '';
}, { immediate: true });
function chooseKind({ value }: { value: string }): void {
  switch (value) {
  case 'local': case 'naidan_rpc': props.inferenceLocation.setKind({ value }); break;
  default: throw new Error('Unknown image inference location');
  }
}
function chooseRegistration({ value }: { value: string }): void {
  props.inferenceLocation.chooseRegistration({ id: props.inferenceLocation.entries.value.find(entry => idToRaw({ id: entry.registration.id }) === value)?.registration.id });
}
function applyConfiguration(): void {
  if (props.disabled) return;
  try {
    if (configuration.value.length > 65536) throw new Error('The model configuration is too large');
    props.inferenceLocation.selectModel({ value: JSON.parse(configuration.value) }); configurationError.value = '';
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
    <select :id="id + '-inference-location'" :value="inferenceLocation.kind.value" @change="chooseKind({ value: ($event.target as HTMLSelectElement).value })" :disabled="disabled" data-testid="image-inference-location-kind" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40">
      <option value="local">{{ lazyStrings.ImageInferenceLocation__this_device() }}</option>
      <option v-if="enabled" value="naidan_rpc">Naidan RPC</option>
      <option v-else-if="inferenceLocation.kind.value === 'naidan_rpc'" value="naidan_rpc" disabled>{{ lazyStrings.naidanRpc__disabled() }}</option>
    </select>
    <template v-if="inferenceLocation.kind.value === 'naidan_rpc'">
      <label :for="id + '-registration'" tw-class="block text-xs font-semibold">{{ lazyStrings.naidanRpc__choose_connection() }}</label>
      <select :id="id + '-registration'" :value="inferenceLocation.registrationKey.value" :disabled="disabled" @change="chooseRegistration({ value: ($event.target as HTMLSelectElement).value })" data-testid="image-inference-location-registration" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-100 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40">
        <option value="">{{ lazyStrings.naidanRpc__choose_connection() }}</option>
        <option v-for="entry in inferenceLocation.entries.value" :key="idToRaw({ id: entry.registration.id })" :value="idToRaw({ id: entry.registration.id })">{{ entry.registration.label }}</option>
        <option v-if="inferenceLocation.registrationId.value && !inferenceLocation.entries.value.some(entry => entry.registration.id === inferenceLocation.registrationId.value)" :value="inferenceLocation.registrationKey.value" disabled>{{ inferenceLocation.label.value || inferenceLocation.registrationKey.value }}</option>
      </select>
      <p v-if="!enabled" role="status" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ lazyStrings.naidanRpc__enable_first() }}</p>
      <p v-else-if="!inferenceLocation.connected.value" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.ImageInferenceLocation__connect_in_rpc_settings() }}</p>
      <div tw-class="flex flex-wrap gap-3">
        <button type="button" @click="manage" tw-class="text-xs font-semibold text-blue-600 dark:text-blue-400">{{ lazyStrings.naidanRpc__manage() }}</button>
        <button type="button" @click="inferenceLocation.refresh({ fromStorage: true })" :disabled="disabled" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageInferenceLocation__refresh_connections() }}</button>
        <button type="button" @click="inferenceLocation.loadModels()" :disabled="disabled || !inferenceLocation.connected.value || inferenceLocation.loading.value" data-testid="image-inference-location-models" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageInferenceLocation__list_remote_models() }}</button>
      </div>
      <p v-if="inferenceLocation.selection.value" tw-class="text-xs break-all" data-testid="image-inference-location-selected-model">{{ inferenceLocation.selection.value.primary.file.location.path }}</p>
      <ImageSettingsSection compact :title="lazyStrings.ImageInferenceLocation__explicit_model_configuration()" :summary="undefined">
        <textarea v-model="configuration" :aria-label="lazyStrings.ImageInferenceLocation__explicit_model_configuration()" rows="6" maxlength="65536" :disabled="disabled" data-testid="image-inference-location-configuration" tw-class="mt-2 block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-xs font-mono" />
        <button type="button" @click="applyConfiguration" :disabled="disabled" data-testid="image-inference-location-apply-configuration" tw-class="mt-2 text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageInferenceLocation__use_configuration() }}</button>
        <p v-if="configurationError" role="alert" tw-class="text-xs text-red-600 break-words">{{ configurationError }}</p>
      </ImageSettingsSection>
      <!-- Choosing existing files for one request is not provider-side model
           management. Download/import/delete and settings writes are deliberately
           not offered by this RPC surface. -->
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageInferenceLocation__remote_models_are_read_only() }}</p>
      <p v-if="inferenceLocation.failure.value" role="alert" tw-class="text-xs text-red-600 break-words">{{ inferenceLocation.failure.value }}</p>
    </template>
  </section>
</template>
