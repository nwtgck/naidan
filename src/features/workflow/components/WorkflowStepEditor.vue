<script setup lang="ts">
import { computed, inject } from 'vue';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import type { WorkflowStep } from '@/01-models/workflow';
import type { Endpoint, Volume } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { idToRaw, toVolumeId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowMessageEditor from './WorkflowMessageEditor.vue';
import { workflowInputText, workflowStepLabel } from '@/features/workflow/logic/forms';

const props = defineProps<{ step: WorkflowStep, steps: WorkflowStep[], volumes: Volume[], disabled: boolean }>();
const emit = defineEmits<{ change: [step: WorkflowStep], currentModel: [], partial: [] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const formDisabled = computed(() => props.disabled || (drafts?.dirty.value ?? false));

function endpointType({ event }: { event: Event }): void {
  const step = props.step;
  if (step.type !== 'text_generation' || step.target.type !== 'model') {
    return;
  }
  const type = workflowInputText({ event });
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
  emit('change', { ...step, target: { ...step.target, endpoint } });
}

function parameter({ key, event }: { key: 'temperature' | 'maxCompletionTokens', event: Event }): void {
  switch (props.step.type) {
  case 'text_generation': break;
  case 'value': case 'parse_json': case 'request_input': case 'repeat': case 'for_each': case 'if': case 'read_file': case 'write_file': return;
  default: {
    const exhaustive: never = props.step;
    throw new Error(`Unknown step: ${exhaustive}`);
  }
  }
  const text = workflowInputText({ event });
  const value = text === '' ? undefined : Number(text);
  if (value !== undefined && !Number.isFinite(value)) {
    return;
  }
  emit('change', { ...props.step, lmParameters: { ...(props.step.lmParameters ?? EMPTY_LM_PARAMETERS), [key]: value } });
}

function fileFormat({ event }: { event: Event }): void {
  const value = workflowInputText({ event });
  if (props.step.type === 'write_file' && (value === 'text' || value === 'json' || value === 'jsonl' || value === 'binary')) {
    emit('change', { ...props.step, format: value });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="workflow-step-editor">
    <div tw-class="space-y-1">
      <p tw-class="text-xs font-medium text-blue-600 dark:text-blue-400">{{ workflowStepLabel({ type: step.type }) }}</p>
      <label tw-class="block text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__name() }}<input :value="step.name" :disabled="formDisabled" @input="emit('change', { ...step, name: workflowInputText({ event: $event }) })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 mt-1" /></label>
      <code tw-class="block text-[10px] text-gray-400 break-all select-all">{{ idToRaw({ id: step.id }) }}</code>
    </div>
    <WorkflowValueEditor v-if="step.type === 'value'" :value="step.value" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, value: $event })" />
    <WorkflowValueEditor v-else-if="step.type === 'parse_json' || step.type === 'for_each'" :value="step.source" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, source: $event })" />
    <WorkflowValueEditor v-else-if="step.type === 'repeat'" :value="step.count" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, count: $event })" />
    <WorkflowValueEditor v-else-if="step.type === 'if'" :value="step.condition" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, condition: $event })" />
    <template v-else-if="step.type === 'request_input'">
      <WorkflowValueEditor :value="step.prompt" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, prompt: $event })" />
      <select :value="step.responseType" :disabled="formDisabled" @change="emit('change', { ...step, responseType: workflowInputText({ event: $event }) === 'json' ? 'json' : 'text' })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"><option value="text">text</option><option value="json">JSON</option></select>
    </template>
    <template v-else-if="step.type === 'text_generation'">
      <div tw-class="space-y-2">
        <div tw-class="flex flex-wrap items-center justify-between gap-2"><h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__model() }}</h3><button type="button" :disabled="formDisabled" @click="emit('currentModel')" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__use_current_model() }}</button></div>
        <template v-if="step.target.type === 'model'">
          <select :value="step.target.endpoint.type" :disabled="formDisabled" @change="endpointType({ event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" :aria-label="lazyStrings.workflow__endpoint()">
            <option value="openai">OpenAI compatible</option><option value="ollama">Ollama</option><option value="llama_cpp_browser">llama.cpp browser</option><option value="transformers_js">Transformers.js</option><option value="browser_provided_lm">Browser LM</option>
            <option v-if="step.target.endpoint.type === 'naidan_rpc' || step.target.endpoint.type === 'unsupported_experimental_endpoint'" :value="step.target.endpoint.type">{{ step.target.endpoint.type }}</option>
          </select>
          <input v-if="step.target.endpoint.type === 'openai' || step.target.endpoint.type === 'ollama'" :value="step.target.endpoint.url" :disabled="formDisabled" @change="emit('change', { ...step, target: { ...step.target, endpoint: { ...step.target.endpoint, url: workflowInputText({ event: $event }) } } })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" :aria-label="lazyStrings.workflow__endpoint()" />
          <input :value="step.target.modelId" :disabled="formDisabled" @input="emit('change', { ...step, target: { ...step.target, modelId: workflowInputText({ event: $event }) } })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" :placeholder="lazyStrings.workflow__model_id()" :aria-label="lazyStrings.workflow__model_id()" />
          <details tw-class="text-xs text-gray-500"><summary>{{ lazyStrings.workflow__step_reference() }} / JSON</summary><WorkflowValueEditor :value="step.target" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, target: $event })" /></details>
        </template>
        <WorkflowValueEditor v-else :value="step.target" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, target: $event })" />
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__connections_notice() }}</p>
      </div>
      <div tw-class="space-y-2">
        <h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__system_prompt() }}</h3>
        <textarea :value="step.systemPrompt?.content ?? ''" :disabled="formDisabled" rows="3" @input="emit('change', { ...step, systemPrompt: workflowInputText({ event: $event }) ? { behavior: 'override', content: workflowInputText({ event: $event }) } : undefined })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" />
      </div>
      <details tw-class="space-y-2"><summary tw-class="cursor-pointer text-sm font-semibold">{{ lazyStrings.workflow__conversation() }}</summary>
        <WorkflowMessageEditor v-if="step.conversation.type === 'conversation'" :messages="step.conversation.messages" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, conversation: { type: 'conversation', messages: $event } })" />
        <WorkflowValueEditor :value="step.conversation" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, conversation: $event })" />
      </details>
      <div tw-class="space-y-2"><h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__append_messages() }}</h3><WorkflowMessageEditor :messages="step.appendMessages" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, appendMessages: $event })" /></div>
      <div tw-class="grid grid-cols-2 gap-3">
        <label tw-class="text-xs">{{ lazyStrings.workflow__temperature() }}<input type="number" min="0" step="0.1" :value="step.lmParameters?.temperature" :disabled="formDisabled" @change="parameter({ key: 'temperature', event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 mt-1" /></label>
        <label tw-class="text-xs">{{ lazyStrings.workflow__max_tokens() }}<input type="number" min="1" step="1" :value="step.lmParameters?.maxCompletionTokens" :disabled="formDisabled" @change="parameter({ key: 'maxCompletionTokens', event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 mt-1" /></label>
      </div>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__tools_notice() }}</p>
    </template>
    <template v-else-if="step.type === 'read_file' || step.type === 'write_file'">
      <label tw-class="block text-sm">{{ lazyStrings.workflow__folder() }}<select :value="idToRaw({ id: step.volumeId })" :disabled="formDisabled" @change="emit('change', { ...step, volumeId: toVolumeId({ raw: workflowInputText({ event: $event }) }) })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 mt-1"><option value="">{{ lazyStrings.workflow__not_selected() }}</option><option v-for="volume in volumes" :key="idToRaw({ id: volume.id })" :value="idToRaw({ id: volume.id })">{{ volume.name }}</option></select></label>
      <h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__path() }}</h3><WorkflowValueEditor :value="step.relativePath" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, relativePath: $event })" />
      <template v-if="step.type === 'write_file'">
        <h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__source() }}</h3><WorkflowValueEditor :value="step.source" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, source: $event })" />
        <label tw-class="block text-sm">{{ lazyStrings.workflow__format() }}<select :value="step.format" :disabled="formDisabled" @change="fileFormat({ event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 mt-1"><option value="text">text</option><option value="json">JSON</option><option value="jsonl">JSON Lines</option><option value="binary">binary</option></select></label>
        <label tw-class="block text-sm">{{ lazyStrings.workflow__on_conflict() }}<select :value="step.onConflict" :disabled="formDisabled" @change="emit('change', { ...step, onConflict: workflowInputText({ event: $event }) === 'overwrite' ? 'overwrite' : 'error' })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 mt-1"><option value="error">{{ lazyStrings.workflow__error() }}</option><option value="overwrite">{{ lazyStrings.workflow__overwrite() }}</option></select></label>
      </template>
    </template>
    <p v-if="step.type === 'repeat' || step.type === 'for_each' || step.type === 'if'" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__state_notice() }}</p>
    <button type="button" :disabled="formDisabled" @click="emit('partial')" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 w-full">{{ lazyStrings.workflow__partial_json() }}</button>
  </section>
</template>
