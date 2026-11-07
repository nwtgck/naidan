<script setup lang="ts">
import { computed, inject, provide, ref } from 'vue';
import { PlusIcon, Trash2Icon } from 'lucide-vue-next';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { workflowValueScopeKey } from '@/features/workflow/composables/value-context';
import { analyzeWorkflowTypes, emptyWorkflowTypeScope } from '@/features/workflow/logic/value-types';
import type { WorkflowDefinition, WorkflowStep, WorkflowLoopState } from '@/01-models/workflow';
import type { Volume } from '@/01-models/types';
import { idToRaw, toVolumeId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import LmParametersEditor from '@/components/LmParametersEditor.vue';
import WorkflowGenerationToolsEditor from './WorkflowGenerationToolsEditor.vue';
import WorkflowToolEditor from './WorkflowToolEditor.vue';
import WorkflowAudioEditor from './WorkflowAudioEditor.vue';
import WorkflowImageEditor from './WorkflowImageEditor.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowMessageEditor from './WorkflowMessageEditor.vue';
import WorkflowModelEditor from './WorkflowModelEditor.vue';
import WorkflowValueMapEditor from './WorkflowValueMapEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import { workflowInputText, workflowStepLabel } from '@/features/workflow/logic/forms';
const props = defineProps<{ step: WorkflowStep, steps: WorkflowStep[], definition?: WorkflowDefinition, volumes: Volume[], disabled: boolean }>();
const emit = defineEmits<{ change: [step: WorkflowStep], currentModel: [], partial: [] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const formDisabled = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const analysis = computed(() => analyzeWorkflowTypes({ definition: props.definition ?? { name: '', steps: props.steps } }));
const emptyScope = emptyWorkflowTypeScope();
const scope = computed(() => analysis.value.inputs.get(props.step.id) ?? emptyScope);
const bodyScope = computed(() => analysis.value.bodies.get(props.step.id) ?? scope.value);
provide(workflowValueScopeKey, scope);
const fileFormats: { value: 'text' | 'json' | 'jsonl' | 'binary', label: string }[] = [{ value: 'text', label: 'text' }, { value: 'json', label: 'JSON' }, { value: 'jsonl', label: 'JSON Lines' }, { value: 'binary', label: 'binary' }];
const volumeOptions = computed(() => [{ value: '', label: lazyStrings.workflow__not_selected() }, ...props.volumes.map(volume => ({ value: idToRaw({ id: volume.id }), label: volume.name }))]);
const stateKey = ref('');

function toggleChoices(): void {
  if (formDisabled.value || props.step.type !== 'request_input') {
    return;
  }
  emit('change', {
    ...props.step,
    responseType: 'text',
    choices: props.step.choices === undefined ? { type: 'array', items: [{ type: 'literal', value: '' }, { type: 'literal', value: '' }] } : undefined,
  });
}

function addState(): void {
  const step = props.step;
  if ((step.type !== 'repeat' && step.type !== 'for_each') || formDisabled.value || !stateKey.value || Object.hasOwn(step.state, stateKey.value)) {
    return;
  }
  const key = stateKey.value;
  emit('change', { ...step, state: Object.fromEntries([...Object.entries(step.state), [key, { initial: { type: 'literal', value: null }, next: { type: 'loop_state', stepId: step.id, key } }]]) });
  stateKey.value = '';
}

function updateState({ key, value }: { key: string, value: WorkflowLoopState[string] | undefined }): void {
  const step = props.step;
  if (step.type !== 'repeat' && step.type !== 'for_each') {
    return;
  }
  const entries = Object.entries(step.state).filter(([name]) => name !== key);
  if (value) {
    entries.push([key, value]);
  }
  emit('change', { ...step, state: Object.fromEntries(entries) });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="workflow-step-editor">
    <div tw-class="space-y-2">
      <p tw-class="text-xs font-semibold text-blue-600 dark:text-blue-400">{{ workflowStepLabel({ type: step.type }) }}</p>
      <label tw-class="block text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__name() }}<input :value="step.name" :disabled="formDisabled" @input="emit('change', { ...step, name: workflowInputText({ event: $event }) })" tw-class="mt-1 w-full min-w-0 rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2.5 text-sm text-gray-800 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" /></label>
      <code tw-class="block text-[10px] text-gray-400 break-all select-all">{{ idToRaw({ id: step.id }) }}</code>
    </div>
    <WorkflowValueEditor v-if="step.type === 'value'" :value="step.value" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, value: $event })" />
    <WorkflowValueEditor v-else-if="step.type === 'parse_json' || step.type === 'for_each'" :value="step.source" :expected="step.type === 'for_each' ? 'iterable' : 'text'" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, source: $event })" />
    <WorkflowValueEditor v-else-if="step.type === 'repeat'" :value="step.count" expected="number" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, count: $event })" />
    <WorkflowValueEditor v-else-if="step.type === 'if'" :value="step.condition" expected="boolean" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, condition: $event })" />
    <template v-else-if="step.type === 'model_selection'">
      <div v-for="(target, index) in step.targets" :key="index" tw-class="p-3 rounded-xl border border-gray-200 dark:border-gray-700 space-y-3">
        <div tw-class="flex justify-between items-center"><span tw-class="text-xs font-medium text-gray-500">{{ index + 1 }}</span><button type="button" :disabled="formDisabled" :aria-label="lazyStrings.workflow__delete()" @click="emit('change', { ...step, targets: step.targets.filter((_, i) => i !== index) })" tw-class="p-1 rounded-lg text-gray-400 hover:text-red-500 disabled:opacity-40"><Trash2Icon tw-class="w-4 h-4" /></button></div>
        <WorkflowModelEditor :value="target" :disabled="formDisabled" :show-parameters="true" @change="emit('change', { ...step, targets: step.targets.map((item, i) => i === index ? $event : item) })" />
      </div>
      <button type="button" :disabled="formDisabled" @click="emit('change', { ...step, targets: [...step.targets, { endpoint: { type: 'llama_cpp_browser' }, modelId: '', lmParameters: undefined }] })" tw-class="flex items-center gap-2 w-full justify-center rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-3 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40"><PlusIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__model() }}</button>
    </template>
    <WorkflowToolEditor v-else-if="step.type === 'tool_call'" :step="step" :steps="steps" :volumes="volumes" :disabled="disabled" @change="emit('change', $event)" />
    <template v-else-if="step.type === 'request_input'">
      <WorkflowValueEditor :value="step.prompt" :steps="steps" :disabled="disabled" expected="text" @change="emit('change', { ...step, prompt: $event })" />
      <label tw-class="flex items-center gap-2 text-xs"><ToggleSwitch><input type="checkbox" :checked="step.choices !== undefined" :disabled="formDisabled" data-testid="workflow-fixed-choices" @change="toggleChoices" /></ToggleSwitch>{{ lazyStrings.workflow__fixed_choices() }}</label>
      <template v-if="step.choices !== undefined">
        <WorkflowValueEditor :value="step.choices" :steps="steps" :disabled="disabled" expected="iterable" @change="emit('change', { ...step, choices: $event })" />
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__choices_help() }}</p>
      </template>
      <SettingsFormSelect :model-value="step.responseType" :disabled="formDisabled || step.choices !== undefined" :options="[{ value: 'text' as const, label: lazyStrings.workflow__literal_text() }, { value: 'json' as const, label: 'JSON' }]" :label="lazyStrings.workflow__format()" @update:model-value="emit('change', { ...step, responseType: $event })" />
    </template>
    <template v-else-if="step.type === 'text_generation'">
      <div tw-class="space-y-3">
        <div tw-class="flex flex-wrap items-center justify-between gap-2"><h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__model() }}</h3><button type="button" :disabled="formDisabled" @click="emit('currentModel')" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__use_current_model() }}</button></div>
        <WorkflowValueEditor :value="step.target" expected="model" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, target: $event })" />
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__connections_notice() }}</p>
      </div>
      <div tw-class="space-y-2">
        <h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__system_prompt() }}</h3>
        <SettingsFormSelect :model-value="step.systemPrompt?.behavior ?? 'override'" :disabled="formDisabled" :options="[{ value: 'override' as const, label: 'override' }, { value: 'append' as const, label: 'append' }]" :label="lazyStrings.workflow__format()" @update:model-value="emit('change', { ...step, systemPrompt: { behavior: $event, content: step.systemPrompt?.content ?? '' } })" />
        <textarea :value="step.systemPrompt?.content ?? ''" :disabled="formDisabled" rows="3" @input="emit('change', { ...step, systemPrompt: { behavior: step.systemPrompt?.behavior ?? 'override', content: workflowInputText({ event: $event }) } })" :aria-label="lazyStrings.workflow__system_prompt()" tw-class="w-full min-w-0 resize-y rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" />
      </div>
      <WorkflowDisclosure :title="lazyStrings.workflow__conversation()" :initially-open="step.conversation.type !== 'conversation' || step.conversation.messages.length > 0">
        <template #summary><span v-if="step.conversation.type === 'conversation'" tw-class="text-xs text-gray-500">{{ step.conversation.messages.length }}</span></template>
        <WorkflowValueEditor :value="step.conversation" :steps="steps" :disabled="disabled" expected="conversation" @change="emit('change', { ...step, conversation: $event })" />
      </WorkflowDisclosure>
      <div tw-class="space-y-2"><h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__append_messages() }}</h3><WorkflowMessageEditor :messages="step.appendMessages" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, appendMessages: $event })" /></div>
      <WorkflowGenerationToolsEditor :step="step" :volumes="volumes" :disabled="disabled" @change="emit('change', $event)" />
      <WorkflowDisclosure :title="lazyStrings.workflow__parameters()" :initially-open="!!step.lmParameters"><fieldset :disabled="formDisabled"><LmParametersEditor :model-value="step.lmParameters" @update:model-value="emit('change', { ...step, lmParameters: $event })" /></fieldset></WorkflowDisclosure>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__tools_notice() }}</p>
    </template>
    <WorkflowAudioEditor v-else-if="step.type === 'audio_generation'" :step="step" :steps="steps" :disabled="disabled" @change="emit('change', $event)" />
    <WorkflowImageEditor v-else-if="step.type === 'image_generation'" :step="step" :steps="steps" :disabled="disabled" @change="emit('change', $event)" />
    <template v-else-if="step.type === 'read_file' || step.type === 'write_file'">
      <SettingsFormSelect :model-value="idToRaw({ id: step.volumeId })" :options="volumeOptions" :disabled="formDisabled" :label="lazyStrings.workflow__folder()" @update:model-value="emit('change', { ...step, volumeId: toVolumeId({ raw: $event }) })" />
      <h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__path() }}</h3><WorkflowValueEditor :value="step.relativePath" expected="text" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, relativePath: $event })" />
      <template v-if="step.type === 'write_file'">
        <h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__source() }}</h3><WorkflowValueEditor :value="step.source" :expected="step.format === 'text' ? 'text' : step.format === 'binary' ? 'binary' : step.format === 'jsonl' ? 'iterable' : 'json'" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, source: $event })" />
        <SettingsFormSelect :model-value="step.format" :options="fileFormats" :disabled="formDisabled" :label="lazyStrings.workflow__format()" @update:model-value="emit('change', { ...step, format: $event })" />
        <SettingsFormSelect :model-value="step.onConflict" :disabled="formDisabled" :options="[{ value: 'error' as const, label: lazyStrings.workflow__error() }, { value: 'overwrite' as const, label: lazyStrings.workflow__overwrite() }]" :label="lazyStrings.workflow__on_conflict()" @update:model-value="emit('change', { ...step, onConflict: $event })" />
      </template>
    </template>
    <template v-if="step.type === 'repeat' || step.type === 'for_each'">
      <WorkflowDisclosure :title="lazyStrings.workflow__loop_state()" :initially-open="Object.keys(step.state).length > 0">
        <template #summary><span tw-class="text-xs text-gray-500">{{ Object.keys(step.state).length }}</span></template>
        <div v-for="(state, key) in step.state" :key="key" tw-class="space-y-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
          <div tw-class="flex justify-between items-center"><code tw-class="text-xs">{{ key }}</code><button type="button" :disabled="formDisabled" :aria-label="lazyStrings.workflow__delete()" @click="updateState({ key: String(key), value: undefined })" tw-class="text-gray-400 hover:text-red-500"><Trash2Icon tw-class="w-4 h-4" /></button></div>
          <p tw-class="text-xs text-gray-500">{{ lazyStrings.workflow__initial_value() }}</p><WorkflowValueEditor :value="state.initial" :steps="steps" :scope="scope" :disabled="disabled" @change="updateState({ key: String(key), value: { ...state, initial: $event } })" />
          <p tw-class="text-xs text-gray-500">{{ lazyStrings.workflow__next_value() }}</p><WorkflowValueEditor :value="state.next" :steps="steps" :scope="bodyScope" :disabled="disabled" @change="updateState({ key: String(key), value: { ...state, next: $event } })" />
        </div>
        <div tw-class="flex gap-2"><input v-model="stateKey" :disabled="formDisabled" :aria-label="lazyStrings.workflow__key()" tw-class="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-2 text-xs outline-none focus:ring-2 focus:ring-blue-500/40" /><button type="button" :disabled="formDisabled || !stateKey || Object.hasOwn(step.state, stateKey)" @click="addState" tw-class="rounded-lg px-2 text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.workflow__add_field() }}</button></div>
      </WorkflowDisclosure>
      <div tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-3" data-testid="workflow-loop-stop">
        <label tw-class="flex items-center justify-between gap-3 text-sm"><span>{{ lazyStrings.workflow__stop_after_iteration() }}</span><ToggleSwitch><input type="checkbox" :disabled="formDisabled" :checked="step.stopWhen !== undefined" :aria-label="lazyStrings.workflow__stop_after_iteration()" @change="emit('change', { ...step, stopWhen: step.stopWhen === undefined ? { type: 'literal', value: false } : undefined })" /></ToggleSwitch></label>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__loop_stop_hint() }}</p>
        <WorkflowValueEditor v-if="step.stopWhen !== undefined" :value="step.stopWhen" :steps="steps" :scope="bodyScope" :disabled="disabled" expected="boolean" @change="emit('change', { ...step, stopWhen: $event })" />
      </div>
      <label tw-class="flex justify-between items-center gap-3 text-sm"><span>{{ lazyStrings.workflow__collect_results() }}</span><ToggleSwitch><input type="checkbox" :disabled="formDisabled" :checked="step.emit !== undefined" @change="emit('change', { ...step, emit: step.emit === undefined ? { type: 'literal', value: null } : undefined })" /></ToggleSwitch></label>
      <WorkflowValueEditor v-if="step.emit !== undefined" :value="step.emit" :steps="steps" :scope="bodyScope" :disabled="disabled" expected="json" @change="emit('change', { ...step, emit: $event })" />
    </template>
    <template v-if="step.type === 'if'">
      <WorkflowDisclosure v-for="branch in (['then', 'else'] as const)" :key="branch" :title="branch === 'then' ? lazyStrings.workflow__then() : lazyStrings.workflow__else()" :initially-open="true">
        <template #summary><span tw-class="text-xs text-gray-500">{{ lazyStrings.workflow__output() }}</span></template>
        <WorkflowValueMapEditor :values="step[branch].outputs" :steps="steps" :scope="analysis.branches.get(step.id)?.[branch] ?? scope" :disabled="disabled" @change="emit('change', { ...step, [branch]: { ...step[branch], outputs: $event } })" />
      </WorkflowDisclosure>
    </template>
    <button type="button" :disabled="formDisabled" @click="emit('partial')" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 w-full transition-colors">{{ lazyStrings.workflow__partial_json() }}</button>
  </section>
</template>
