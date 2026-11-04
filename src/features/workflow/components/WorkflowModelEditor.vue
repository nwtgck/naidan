<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import type { WorkflowModelConfiguration } from '@/01-models/workflow';
import type { Endpoint } from '@/01-models/types';
import { cloneEndpoint } from '@/01-models/endpoint';
import { useSettings } from '@/composables/useSettings';
import { naturalSort } from '@/utils/string';
import HttpHeadersEditor from '@/components/HttpHeadersEditor.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import LmParametersEditor from '@/components/LmParametersEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import { lazyStrings } from '@/strings';
import { workflowInputText } from '@/features/workflow/logic/forms';
const props = defineProps<{ value: WorkflowModelConfiguration, disabled: boolean, showParameters: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowModelConfiguration] }>();
const { settings } = useSettings();
const models = ref<string[]>([]), loading = ref(false), failed = ref(false);
let controller: AbortController | undefined;
let alive = true;
const endpointOptions = computed(() => [
  { value: 'openai', label: 'OpenAI compatible' }, { value: 'ollama', label: 'Ollama' },
  { value: 'llama_cpp_browser', label: 'llama.cpp browser' }, { value: 'transformers_js', label: 'Transformers.js' },
  { value: 'browser_provided_lm', label: 'Browser LM' },
  ...(!['openai', 'ollama', 'llama_cpp_browser', 'transformers_js', 'browser_provided_lm'].includes(props.value.endpoint.type) ? [{ value: props.value.endpoint.type, label: props.value.endpoint.type, disabled: true }] : []),
]);
watch(() => JSON.stringify(props.value.endpoint), () => {
  controller?.abort();
  controller = undefined;
  models.value = [];
  loading.value = false;
  failed.value = false;
}, { flush: 'sync' });
watch(() => props.disabled, disabled => {
  if (disabled) {
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
});
onBeforeUnmount(() => {
  alive = false;
  controller?.abort();
});

function endpointType({ type }: { type: string }): void {
  if (props.disabled) {
    return;
  }
  let endpoint: Endpoint;
  switch (type) {
  case 'openai': endpoint = { type, url: 'http://localhost:1234/v1' };
    break;
  case 'ollama': endpoint = { type, url: 'http://localhost:11434' };
    break;
  case 'llama_cpp_browser': case 'transformers_js': case 'browser_provided_lm': endpoint = { type };
    break;
  default: return;
  }
  // A model ID belongs to its connection. Never silently keep a remote ID when
  // switching to another backend; the caller chooses a matching candidate.
  emit('change', { ...props.value, endpoint, modelId: '' });
}

async function refresh(): Promise<void> {
  if (props.disabled) {
    return;
  }
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const endpoint = cloneEndpoint({ endpoint: props.value.endpoint });
  const key = JSON.stringify(endpoint);
  const current = () => alive && !props.disabled && controller === request && !request.signal.aborted && JSON.stringify(props.value.endpoint) === key;
  loading.value = true;
  failed.value = false;
  try {
    // Candidate discovery only happens after an explicit selector/open/refresh
    // interaction, never merely by rendering an imported connection.
    const { loadLmProvider } = await import('@/features/lm/providerFactory');
    if (!current()) {
      return;
    }
    const provider = await loadLmProvider({ endpoint, fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled' });
    if (!current()) {
      return;
    }
    const found = await provider.listModels({ signal: request.signal });
    if (current()) {
      models.value = naturalSort({ values: [...new Set(found.filter(id => id.trim()))] });
    }
  } catch {
    if (current()) {
      failed.value = true;
    }
  } finally {
    if (controller === request) {
      loading.value = false;
      controller = undefined;
    }
  }
}

function opened({ open }: { open: boolean }): void {
  if (open && !models.value.length && !loading.value && !failed.value) {
    void refresh();
  }
}

function setId({ modelId }: { modelId: string | undefined }): void {
  if (!props.disabled) {
    emit('change', { ...props.value, modelId: modelId ?? '' });
  }
}

const parameterSummary = computed(() => props.value.lmParameters ? JSON.stringify(props.value.lmParameters) : '');
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3" data-testid="workflow-model-editor">
    <SettingsFormSelect :model-value="value.endpoint.type" :options="endpointOptions" :disabled="disabled" :label="lazyStrings.workflow__endpoint()" @update:model-value="endpointType({ type: $event })" />
    <input v-if="value.endpoint.type === 'openai' || value.endpoint.type === 'ollama'" :value="value.endpoint.url" :disabled="disabled" :aria-label="lazyStrings.workflow__endpoint()" @change="emit('change', { ...value, endpoint: { ...value.endpoint, url: workflowInputText({ event: $event }) } })" type="url" spellcheck="false" tw-class="w-full min-w-0 rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" />
    <fieldset v-if="value.endpoint.type === 'openai' || value.endpoint.type === 'ollama'" :disabled="disabled"><HttpHeadersEditor :model-value="value.endpoint.httpHeaders ?? []" test-id-prefix="workflow-headers" @update:model-value="emit('change', { ...value, endpoint: { ...value.endpoint, httpHeaders: $event } })" /></fieldset>
    <ModelSelector data-testid="workflow-model-selector" :model-value="value.modelId" :models="models" :loading="loading" :disabled="disabled" surface="settings" @update:model-value="setId({ modelId: $event })" @update:open="opened({ open: $event })" @refresh="refresh" />
    <input data-testid="workflow-model-id" :value="value.modelId" :disabled="disabled" @input="setId({ modelId: workflowInputText({ event: $event }) })" :placeholder="lazyStrings.workflow__model_id()" :aria-label="lazyStrings.workflow__model_id()" spellcheck="false" tw-class="w-full min-w-0 rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" />
    <p v-if="failed" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.workflow__model_candidates_failed() }}</p>
    <WorkflowDisclosure v-if="showParameters" :title="lazyStrings.workflow__parameters()" :initially-open="!!value.lmParameters">
      <template #summary><span v-if="parameterSummary" tw-class="max-w-32 truncate text-xs font-normal text-gray-500">{{ parameterSummary }}</span></template>
      <fieldset :disabled="disabled"><LmParametersEditor :model-value="value.lmParameters" @update:model-value="emit('change', { ...value, lmParameters: $event })" /></fieldset>
    </WorkflowDisclosure>
  </div>
</template>
