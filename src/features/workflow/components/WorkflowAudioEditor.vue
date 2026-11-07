<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import type { WorkflowAudioParameters, WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import { currentLocale, lazyStrings } from '@/strings';
import { audioLanguageOptions } from '@/features/audio-generation/languages';
import { audioFieldLabel, audioFieldValidationMessage } from '@/features/audio-generation/validation';
import { useAudioModels } from '@/features/audio-generation/composables/useAudioModels';
import { workflowAudioParameterKeys } from '@/features/workflow/logic/audio-input';
import { workflowInputText } from '@/features/workflow/logic/forms';
import { workflowAudioModelReviewKey } from '@/features/workflow/composables/model-review';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { workflowValueScopeKey } from '@/features/workflow/composables/value-context';
import { emptyWorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { newWorkflowValueInput } from '@/features/workflow/logic/value-inputs';
import ModelSelector from '@/components/ModelSelector.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';

const props = defineProps<{ step: Extract<WorkflowStep, { type: 'audio_generation' }>, steps: WorkflowStep[], disabled: boolean }>();
const emit = defineEmits<{ change: [step: Extract<WorkflowStep, { type: 'audio_generation' }>] }>();
const review = inject(workflowAudioModelReviewKey, undefined);
const drafts = inject(workflowInputDraftsKey, undefined);
const scope = inject(workflowValueScopeKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const modelValueMode = ref(props.step.modelId.type !== 'literal');
const parameterValueModes = ref(new Set<keyof WorkflowAudioParameters>());
const loading = ref(false), failed = ref(false);
const candidates = useAudioModels({ inspect: async ({ modelId, signal }) => (await import('@/features/audio-generation/model-detection')).inspectStoredAudioModel({ modelId, signal }) });
const selectedModelId = computed(() => props.step.modelId.type === 'literal' && typeof props.step.modelId.value === 'string' ? props.step.modelId.value : '');
const models = computed(() => candidates.visibleModels.value.map(entry => entry.modelId));
const languages = computed(() => [{ value: 'default', label: lazyStrings.audioGeneration__model_default() }, ...audioLanguageOptions({ locale: currentLocale.value })]);
const backends = computed(() => [{ value: 'profile', label: lazyStrings.audioGeneration__runtime_audio() }, { value: 'cpu', label: lazyStrings.audioGeneration__cpu_audio() }]);
let controller: AbortController | undefined;
let alive = true;
watch(locked, value => {
  if (value) {
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
});
onBeforeUnmount(() => {
  alive = false;
  controller?.abort();
});

async function refresh(): Promise<void> {
  if (locked.value) {
    return;
  }
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const current = () => alive && !locked.value && controller === request && !request.signal.aborted;
  loading.value = true;
  failed.value = false;
  try {
    const { llamaCppBrowserService } = await import('@/features/llama-cpp-browser');
    if (!current()) {
      return;
    }
    const entries = await llamaCppBrowserService.listModelEntries({ signal: request.signal });
    if (current()) {
      // Candidate detection may choose an internal suggestion, but it must never
      // edit the document or grant authority without a user selection.
      candidates.updateModels({ entries });
    }
  } catch {
    if (current()) {
      failed.value = true;
    }
  } finally {
    if (controller === request) {
      controller = undefined;
      loading.value = false;
    }
  }
}

function opened({ open }: { open: boolean }): void {
  if (open && !loading.value && !candidates.models.value.length && !failed.value) {
    void refresh();
  }
}

function chooseModel({ modelId }: { modelId: string | undefined }): void {
  if (!locked.value) {
    const value = modelId ?? '';
    emit('change', { ...props.step, modelId: { type: 'literal', value } });
    review?.({ modelId: value });
  }
}

function typeModel({ modelId }: { modelId: string }): void {
  if (!locked.value) {
    emit('change', { ...props.step, modelId: { type: 'literal', value: modelId } });
  }
}

function confirmModel({ modelId }: { modelId: string }): void {
  if (!locked.value) {
    review?.({ modelId });
  }
}

function parameter({ key, value }: { key: keyof WorkflowAudioParameters, value: WorkflowValue }): void {
  // Value editors own their draft lock and must be able to apply their own draft.
  if (!props.disabled) {
    emit('change', { ...props.step, parameters: { ...props.step.parameters, [key]: value } });
  }
}

function parameterMode({ key }: { key: keyof WorkflowAudioParameters }): void {
  if (!locked.value) {
    const next = new Set(parameterValueModes.value);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    parameterValueModes.value = next;
  }
}

function reference(): void {
  if (locked.value) {
    return;
  }
  const value = props.step.reference === undefined ? newWorkflowValueInput({ mode: 'step_output', scope: scope?.value ?? emptyWorkflowTypeScope(), expected: 'binary' }) : undefined;
  emit('change', { ...props.step, reference: value ?? (props.step.reference === undefined ? { type: 'literal', value: null } : undefined) });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-4" data-testid="workflow-audio-editor">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__local_audio_help() }}</p>
    <section tw-class="space-y-2">
      <div tw-class="flex items-center justify-between gap-2">
        <h3 tw-class="text-sm font-semibold">{{ lazyStrings.audioGeneration__audio_model() }}</h3>
        <button v-if="modelValueMode && step.modelId.type === 'literal' && typeof step.modelId.value === 'string'" type="button" :disabled="locked" @click="modelValueMode = false" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40" data-testid="workflow-audio-model-fixed">{{ lazyStrings.workflow__fixed_value() }}</button>
        <button v-if="!modelValueMode" type="button" :disabled="locked" @click="modelValueMode = true" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40" data-testid="workflow-audio-model-value">{{ lazyStrings.workflow__choose_value() }}</button>
      </div>
      <WorkflowValueEditor v-if="modelValueMode || step.modelId.type !== 'literal'" :value="step.modelId" :steps="steps" :disabled="disabled" expected="text" @change="emit('change', { ...step, modelId: $event })" />
      <template v-else>
        <ModelSelector :model-value="selectedModelId" :models="models" :loading="loading || candidates.scanState.value === 'scanning'" :disabled="locked" surface="settings" @update:model-value="chooseModel({ modelId: $event })" @update:open="opened({ open: $event })" @refresh="refresh" data-testid="workflow-audio-model-selector" />
        <input :value="selectedModelId" :disabled="locked" :aria-label="lazyStrings.workflow__model_id()" @input="typeModel({ modelId: workflowInputText({ event: $event }) })" @change="confirmModel({ modelId: workflowInputText({ event: $event }) })" spellcheck="false" data-testid="workflow-audio-model-id" tw-class="w-full min-w-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-40" />
        <label tw-class="flex items-center gap-2 text-xs text-gray-500"><ToggleSwitch><input type="checkbox" :checked="candidates.scope.value === 'all'" :disabled="locked" @change="candidates.scope.value = candidates.scope.value === 'all' ? 'detected' : 'all'" /></ToggleSwitch>{{ lazyStrings.audioGeneration__show_all_llama_cpp_browser_models() }}</label>
        <p v-if="failed" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.workflow__model_candidates_failed() }}</p>
        <p v-else-if="candidates.models.value.length && !candidates.detectedCount.value && candidates.scanState.value === 'idle'" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.audioGeneration__no_audio_models_detected() }}</p>
      </template>
    </section>
    <section tw-class="space-y-2">
      <h3 tw-class="text-sm font-semibold">{{ lazyStrings.audioGeneration__input_text() }}</h3>
      <WorkflowValueEditor :value="step.text" :steps="steps" :disabled="disabled" expected="text" @change="emit('change', { ...step, text: $event })" />
    </section>
    <section tw-class="space-y-2">
      <label tw-class="flex items-center gap-2 text-sm font-semibold"><ToggleSwitch><input type="checkbox" :checked="step.reference !== undefined" :disabled="locked" @change="reference" data-testid="workflow-audio-reference-enabled" /></ToggleSwitch>{{ lazyStrings.audioGeneration__reference_voice() }}</label>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__audio_reference_help() }}</p>
      <WorkflowValueEditor v-if="step.reference !== undefined" :value="step.reference" :steps="steps" :disabled="disabled" expected="binary" @change="emit('change', { ...step, reference: $event })" />
    </section>
    <WorkflowDisclosure :title="lazyStrings.audioGeneration__advanced_settings()" :initially-open="false">
      <div v-for="key in workflowAudioParameterKeys" :key="key" tw-class="space-y-2" :data-audio-parameter="key">
        <div tw-class="flex items-center justify-between gap-2"><h4 tw-class="text-xs font-medium">{{ audioFieldLabel({ field: key }) }}</h4><button v-if="(key === 'language' || key === 'audioBackend') && step.parameters[key].type === 'literal'" type="button" :disabled="locked" @click="parameterMode({ key })" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ parameterValueModes.has(key) ? lazyStrings.workflow__fixed_value() : lazyStrings.workflow__choose_value() }}</button></div>
        <SettingsFormSelect v-if="(key === 'language' || key === 'audioBackend') && !parameterValueModes.has(key) && step.parameters[key].type === 'literal'" :model-value="String(step.parameters[key].value)" :options="key === 'language' ? languages : backends" :disabled="locked" :label="audioFieldLabel({ field: key })" @update:model-value="parameter({ key, value: { type: 'literal', value: $event } })" />
        <WorkflowValueEditor v-else :value="step.parameters[key]" :steps="steps" :disabled="disabled" :expected="key === 'language' || key === 'audioBackend' ? 'text' : 'number'" @change="parameter({ key, value: $event })" />
        <p v-if="key !== 'language' && key !== 'audioBackend'" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ audioFieldValidationMessage({ field: key }) }}</p>
      </div>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__sampling_help() }}</p>
    </WorkflowDisclosure>
    <SettingsFormSelect :model-value="step.onLimit" :options="[{ value: 'error' as const, label: lazyStrings.workflow__fail_on_incomplete_audio() }, { value: 'keep' as const, label: lazyStrings.workflow__keep_incomplete_audio() }]" :disabled="locked" :label="lazyStrings.workflow__audio_generation_limit()" @update:model-value="emit('change', { ...step, onLimit: $event })" data-testid="workflow-audio-on-limit" />
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__audio_outputs_help() }}</p>
  </div>
</template>
