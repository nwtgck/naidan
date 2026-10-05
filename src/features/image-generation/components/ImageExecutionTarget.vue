<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { idToRaw } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import type { ImageExecutionTargetView } from '@/features/image-generation/composables/use-image-execution-target';

const props = defineProps<{ target: ImageExecutionTargetView, disabled: boolean }>();
const id = useId(), router = useRouter();
const { settings } = useSettings();
const enabled = computed(() => settings.value.experimental?.naidanRpc === 'enabled');
const configuration = ref(''), configurationError = ref('');
watch(props.target.selection, value => {
  configuration.value = value ? JSON.stringify(value, undefined, 2) : ''; configurationError.value = '';
}, { immediate: true });
function chooseKind({ value }: { value: string }): void {
  switch (value) {
  case 'local': case 'naidan_rpc': props.target.setKind({ value }); break;
  default: throw new Error('Unknown image execution target');
  }
}
function chooseConnection({ value }: { value: string }): void {
  props.target.chooseConnection({ id: props.target.entries.value.find(entry => idToRaw({ id: entry.connection.id }) === value)?.connection.id });
}
function chooseModel({ value }: { value: string }): void {
  const item = props.target.catalog.value[Number(value)];
  if (item?.selection) props.target.selectModel({ value: item.selection });
}
function applyConfiguration(): void {
  if (props.disabled) return;
  try {
    if (configuration.value.length > 65536) throw new Error('The model configuration is too large');
    props.target.selectModel({ value: JSON.parse(configuration.value) }); configurationError.value = '';
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
  <section v-if="enabled || target.kind.value === 'naidan_rpc'" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-3" data-testid="image-execution-target">
    <label :for="id + '-target'" tw-class="block text-xs font-semibold">{{ lazyStrings.ImageExecutionTarget__compute_with() }}</label>
    <select :id="id + '-target'" :value="target.kind.value" @change="chooseKind({ value: ($event.target as HTMLSelectElement).value })" :disabled="disabled" data-testid="image-target-kind" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm disabled:opacity-40">
      <option value="local">{{ lazyStrings.ImageExecutionTarget__this_device() }}</option>
      <option value="naidan_rpc" :disabled="!enabled">Naidan RPC</option>
    </select>
    <template v-if="target.kind.value === 'naidan_rpc'">
      <label :for="id + '-connection'" tw-class="block text-xs font-semibold">{{ lazyStrings.naidanRpc__choose_connection() }}</label>
      <select :id="id + '-connection'" :value="target.connectionKey.value" :disabled="disabled" @change="chooseConnection({ value: ($event.target as HTMLSelectElement).value })" data-testid="image-target-connection" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm disabled:opacity-40">
        <option value="">{{ lazyStrings.naidanRpc__choose_connection() }}</option>
        <option v-for="entry in target.entries.value" :key="idToRaw({ id: entry.connection.id })" :value="idToRaw({ id: entry.connection.id })">{{ entry.connection.label }}</option>
        <option v-if="target.connectionId.value && !target.entries.value.some(entry => entry.connection.id === target.connectionId.value)" :value="target.connectionKey.value" disabled>{{ target.label.value || target.connectionKey.value }}</option>
      </select>
      <p v-if="!enabled" role="status" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ lazyStrings.naidanRpc__enable_first() }}</p>
      <p v-else-if="!target.connected.value" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.ImageExecutionTarget__connect_in_rpc_settings() }}</p>
      <div tw-class="flex flex-wrap gap-3">
        <button type="button" @click="manage" tw-class="text-xs font-semibold text-blue-600 dark:text-blue-400">{{ lazyStrings.naidanRpc__manage() }}</button>
        <button type="button" @click="target.refresh({ fromStorage: true })" :disabled="disabled" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageExecutionTarget__refresh_connections() }}</button>
        <button type="button" @click="target.loadModels()" :disabled="disabled || !target.connected.value || target.loading.value" data-testid="image-target-models" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageExecutionTarget__list_remote_models() }}</button>
      </div>
      <select v-if="target.catalog.value.length" :id="id + '-model'" :aria-label="lazyStrings.ImageExecutionTarget__remote_model()" value="" :disabled="disabled" @change="chooseModel({ value: ($event.target as HTMLSelectElement).value })" data-testid="image-target-model" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
        <option value="" disabled>{{ lazyStrings.ImageExecutionTarget__remote_model() }}</option>
        <option v-for="(item, index) in target.catalog.value" :key="index" :value="index" :disabled="!item.selection">{{ item.label }}</option>
      </select>
      <p v-if="target.selection.value" tw-class="text-xs break-all" data-testid="image-target-selected-model">{{ target.selection.value.primary.file.location.path }}</p>
      <details>
        <summary tw-class="text-xs cursor-pointer">{{ lazyStrings.ImageExecutionTarget__explicit_model_configuration() }}</summary>
        <textarea v-model="configuration" :aria-label="lazyStrings.ImageExecutionTarget__explicit_model_configuration()" rows="6" maxlength="65536" :disabled="disabled" data-testid="image-target-configuration" tw-class="mt-2 block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-xs font-mono" />
        <button type="button" @click="applyConfiguration" :disabled="disabled" data-testid="image-target-apply-configuration" tw-class="mt-2 text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.ImageExecutionTarget__use_configuration() }}</button>
        <p v-if="configurationError" role="alert" tw-class="text-xs text-red-600 break-words">{{ configurationError }}</p>
      </details>
      <!-- Choosing existing files for one request is not provider-side model
           management. Download/import/delete and settings writes are deliberately
           not offered by this RPC surface. -->
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageExecutionTarget__remote_models_are_read_only() }}</p>
      <p v-if="target.failure.value" role="alert" tw-class="text-xs text-red-600 break-words">{{ target.failure.value }}</p>
    </template>
  </section>
</template>
