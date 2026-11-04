<script setup lang="ts">
import { ref, computed, onMounted, watch, provide } from 'vue';
import { PlayIcon, SquareIcon, SaveIcon, Undo2Icon, Redo2Icon, DownloadIcon, FolderOpenIcon, AlertTriangleIcon, BracesIcon, LayersIcon, GitBranchIcon, CopyIcon, Trash2Icon, PackagePlusIcon } from 'lucide-vue-next';
import { onBeforeRouteLeave } from 'vue-router';
import { workflowInputDraftsKey } from './composables/input-drafts';
import { lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import { useWorkflowWorkspace } from './composables/use-workflow-workspace';
import { flatWorkflowSteps, type WorkflowDropTarget } from './logic/editor';
import { ensureWorkflowStepLabel, workflowInputText } from './logic/forms';
import type { WorkflowStep } from '@/01-models/workflow';
import WorkflowDisclosure from './components/WorkflowDisclosure.vue';
import WorkflowStepList from './components/WorkflowStepList.vue';
import WorkflowStepEditor from './components/WorkflowStepEditor.vue';
import WorkflowGraph from './components/WorkflowGraph.vue';
const workspace = useWorkflowWorkspace();
provide(workflowInputDraftsKey, workspace.inlineDrafts);
onBeforeRouteLeave(() => workspace.confirmInlineExit());
const steps = computed(() => flatWorkflowSteps({ steps: workspace.definition.value.steps }));
const showResults = ref(false), response = ref('');
watch(() => workspace.pending.value?.token, () => {
  response.value = '';
  if (workspace.pending.value) {
    showResults.value = true;
  }
});
watch(workspace.runState, state => {
  switch (state) {
  case 'running': showResults.value = true;
    break;
  case 'idle': case 'completed': case 'failed': case 'cancelled': break;
  default: {
    const exhaustive: never = state;
    throw new Error(`Unknown run state: ${exhaustive}`);
  }
  }
});
onMounted(async () => {
  await workspace.refresh();
});

async function add({ type, target }: { type: WorkflowStep['type'], target: WorkflowDropTarget }): Promise<void> {
  workspace.add({ type, name: await ensureWorkflowStepLabel({ type }), target });
}

function currentModel(): void {
  const step = workspace.selected.value;
  if (!step) {
    return;
  }
  switch (step.type) {
  case 'text_generation': {
    const defaults = workspace.defaults();
    workspace.updateStep({ step: { ...step, target: { type: 'model', endpoint: defaults.endpoint, modelId: defaults.modelId }, lmParameters: defaults.lmParameters } });
    break;
  }
  case 'value': case 'model_selection': case 'parse_json': case 'request_input': case 'repeat': case 'for_each': case 'if': case 'read_file': case 'write_file': break;
  default: {
    const exhaustive: never = step;
    throw new Error(`Unknown step: ${exhaustive}`);
  }
  }
}

const status = computed(() => {
  if (workspace.pending.value) {
    return lazyStrings.workflow__waiting();
  }
  switch (workspace.runState.value) {
  case 'idle': return lazyStrings.workflow__no_results();
  case 'running': return lazyStrings.workflow__running();
  case 'completed': return lazyStrings.workflow__completed();
  case 'failed': return lazyStrings.workflow__failed();
  case 'cancelled': return lazyStrings.workflow__cancelled();
  default: {
    const exhaustive: never = workspace.runState.value;
    return exhaustive;
  }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { workspace } }) || {}) });
</script>
<template>
  <main tw-class="absolute inset-0 flex flex-col bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" data-testid="workflow-view">
    <header tw-class="shrink-0 border-b border-gray-200 dark:border-gray-800 px-4 py-3 space-y-3">
      <div tw-class="flex flex-wrap items-center gap-2">
        <div tw-class="flex-1 min-w-48"><p tw-class="text-xs text-blue-600 dark:text-blue-400 font-semibold">{{ workspace.kind.value === 'part' ? lazyStrings.workflow__parts() : lazyStrings.workflow__workflows() }}</p><input :value="workspace.definition.value.name" :placeholder="lazyStrings.workflow__untitled()" :disabled="workspace.navigationLocked.value" @input="workspace.updateName({ name: workflowInputText({ event: $event }) })" :aria-label="lazyStrings.workflow__definition_name()" tw-class="w-full bg-transparent text-lg font-semibold py-1 outline-none border-b border-transparent focus:border-blue-400" /><span tw-class="text-[10px] text-gray-400">{{ workspace.dirty.value ? lazyStrings.workflow__unsaved() : lazyStrings.workflow__saved() }}</span></div>
        <button type="button" :disabled="!workspace.canSave.value || workspace.busy.value || workspace.draftDirty.value" @click="workspace.save({ copy: false })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" data-testid="workflow-save"><SaveIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__save() }}</button>
        <button type="button" :disabled="!workspace.canSave.value || workspace.busy.value || workspace.draftDirty.value" @click="workspace.save({ copy: true })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.workflow__save_copy() }}</button>
        <button v-if="!workspace.running.value" type="button" :disabled="workspace.busy.value || workspace.draftDirty.value || workspace.issues.value.length > 0 || workspace.kind.value === 'part' || workspace.definition.value.steps.length === 0" @click="workspace.start" tw-class="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" data-testid="workflow-run"><PlayIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__run() }}</button>
        <button v-else type="button" @click="workspace.stop" tw-class="inline-flex items-center gap-2 rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2 text-sm font-semibold text-white"><SquareIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__stop() }}</button>
      </div>
      <div tw-class="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/15 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300"><AlertTriangleIcon tw-class="h-4 w-4 shrink-0 mt-0.5" /><p>{{ lazyStrings.workflow__experimental_notice() }}</p></div>
      <p v-if="!workspace.canSave.value" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__saving_unavailable() }}</p>
      <div tw-class="flex flex-wrap items-center gap-1.5">
        <button type="button" @click="showResults = false; workspace.changeMode({ next: 'steps' })" :aria-pressed="!showResults && workspace.mode.value === 'steps'" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><LayersIcon tw-class="h-3.5 w-3.5" />{{ lazyStrings.workflow__steps() }}</button>
        <button type="button" @click="showResults = false; workspace.changeMode({ next: 'json' })" :aria-pressed="!showResults && workspace.mode.value === 'json'" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><BracesIcon tw-class="h-3.5 w-3.5" />{{ lazyStrings.workflow__json() }}</button>
        <button type="button" @click="showResults = false; workspace.changeMode({ next: 'graph' })" :aria-pressed="!showResults && workspace.mode.value === 'graph'" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><GitBranchIcon tw-class="h-3.5 w-3.5" />{{ lazyStrings.workflow__graph() }}</button>
        <button type="button" @click="showResults = true" :aria-pressed="showResults" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.workflow__results() }}<span v-if="workspace.running.value" tw-class="h-1.5 w-1.5 rounded-full bg-blue-500" /></button>
        <span tw-class="flex-1" />
        <button type="button" :disabled="workspace.navigationLocked.value || !workspace.historyState.value.undo" @click="workspace.travel({ direction: 'undo' })" :title="lazyStrings.workflow__undo()" :aria-label="lazyStrings.workflow__undo()" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><Undo2Icon tw-class="h-4 w-4" /></button>
        <button type="button" :disabled="workspace.navigationLocked.value || !workspace.historyState.value.redo" @click="workspace.travel({ direction: 'redo' })" :title="lazyStrings.workflow__redo()" :aria-label="lazyStrings.workflow__redo()" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><Redo2Icon tw-class="h-4 w-4" /></button>
        <button type="button" :disabled="workspace.busy.value" @click="workspace.exportDefinition" :title="lazyStrings.workflow__export_definition()" :aria-label="lazyStrings.workflow__export_definition()" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><DownloadIcon tw-class="h-4 w-4" /></button>
        <button type="button" :disabled="!workspace.saved.value || workspace.busy.value" @click="workspace.remove" :title="lazyStrings.workflow__delete()" :aria-label="lazyStrings.workflow__delete()" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><Trash2Icon tw-class="h-4 w-4" /></button>
      </div>
      <div v-if="workspace.error.value" role="alert" tw-class="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-xs text-red-700 dark:text-red-300 max-h-32 overflow-auto break-words"><p tw-class="font-semibold">{{ lazyStrings.workflow__save_error() }}</p><pre tw-class="whitespace-pre-wrap font-sans mt-1">{{ workspace.error.value }}</pre></div>
    </header>
    <div v-show="!showResults" tw-class="flex-1 min-h-0 flex flex-col">
      <div v-if="workspace.mode.value === 'steps'" tw-class="flex-1 min-h-0 flex flex-col lg:flex-row">
        <section tw-class="min-h-0 flex-1 overflow-auto bg-gray-50/70 dark:bg-gray-950/30 p-4 lg:max-w-xl">
          <div tw-class="mb-3 flex flex-wrap gap-1.5">
            <button type="button" :disabled="workspace.navigationLocked.value || !workspace.selectedIds.value.size" @click="workspace.duplicate" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><CopyIcon tw-class="w-3.5 h-3.5" />{{ lazyStrings.workflow__duplicate() }}</button>
            <button type="button" :disabled="workspace.navigationLocked.value || !workspace.selectedIds.value.size" @click="workspace.deleteSteps" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><Trash2Icon tw-class="w-3.5 h-3.5" />{{ lazyStrings.workflow__delete() }}</button>
            <button type="button" :disabled="workspace.navigationLocked.value || !workspace.canSave.value || !workspace.selectedIds.value.size" @click="workspace.savePart" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><PackagePlusIcon tw-class="w-3.5 h-3.5" />{{ lazyStrings.workflow__save_as_part() }}</button>
          </div>
          <p v-if="!workspace.definition.value.steps.length" tw-class="text-sm text-gray-500 py-6">{{ lazyStrings.workflow__empty_steps() }}</p>
          <WorkflowStepList :steps="workspace.definition.value.steps" :selected="workspace.selectedIds.value" :parent-id="undefined" branch="root" :disabled="workspace.navigationLocked.value" @select="workspace.select" @move="workspace.move" @add="add" @insert-part="workspace.insertPart" />
          <p v-if="workspace.kind.value === 'part'" tw-class="mt-4 text-xs text-gray-500">{{ lazyStrings.workflow__run_part_notice() }}</p>
          <WorkflowDisclosure v-if="workspace.issues.value.length" :title="lazyStrings.workflow__validation()" :initially-open="true"><template #summary><span tw-class="text-xs text-amber-600">{{ workspace.issues.value.length }}</span></template><ul tw-class="space-y-2 text-xs text-amber-700 dark:text-amber-400"><li v-for="(issue, index) in workspace.issues.value.slice(0, 50)" :key="index"><code>{{ issue.stepId ? idToRaw({ id: issue.stepId }).slice(0, 6) : '' }} · {{ issue.path }}</code><p>{{ issue.message }}</p></li></ul></WorkflowDisclosure>
        </section>
        <aside tw-class="min-h-0 flex-1 overflow-auto p-4 lg:p-5 border-t lg:border-t-0 lg:border-l border-gray-200 dark:border-gray-800">
          <template v-if="workspace.partialOpen.value">
            <h2 tw-class="text-sm font-semibold mb-2">{{ lazyStrings.workflow__partial_json() }}</h2><p tw-class="mb-3 text-xs text-gray-500">{{ lazyStrings.workflow__partial_notice() }}</p>
            <textarea v-model="workspace.partialDraft.value" :disabled="workspace.busy.value" rows="18" spellcheck="false" tw-class="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-950 p-3 text-xs font-mono focus:ring-2 focus:ring-blue-500" :aria-label="lazyStrings.workflow__partial_json()" />
            <div tw-class="flex gap-2 mt-3"><button type="button" @click="workspace.applyPartial" :disabled="workspace.busy.value" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.workflow__apply() }}</button><button type="button" @click="workspace.closePartial" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.workflow__discard() }}</button></div>
          </template>
          <WorkflowStepEditor v-else-if="workspace.selected.value" :key="idToRaw({ id: workspace.selected.value.id })" :step="workspace.selected.value" :definition="workspace.definition.value" :steps="steps" :volumes="workspace.volumes.value" :disabled="workspace.editingLocked.value" @change="workspace.updateStep({ step: $event })" @current-model="currentModel" @partial="workspace.openPartial" />
          <p v-else tw-class="text-sm text-gray-500 py-8 text-center">{{ lazyStrings.workflow__select_step() }}</p>
        </aside>
      </div>
      <section v-else-if="workspace.mode.value === 'json'" tw-class="flex-1 min-h-0 flex flex-col p-4 gap-3">
        <p tw-class="text-xs text-gray-500">{{ lazyStrings.workflow__json_notice() }}</p>
        <textarea v-model="workspace.jsonDraft.value" :disabled="workspace.busy.value" spellcheck="false" tw-class="flex-1 min-h-32 w-full rounded-xl border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 p-4 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500" :aria-label="lazyStrings.workflow__json()" data-testid="workflow-json" />
        <div><button type="button" :disabled="workspace.busy.value" @click="workspace.applyJson" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" data-testid="workflow-json-apply">{{ lazyStrings.workflow__apply() }}</button></div>
      </section>
      <WorkflowGraph v-else :definition="workspace.definition.value" @select="workspace.changeMode({ next: 'steps' }).then(() => workspace.select({ id: $event, multiple: false }))" />
    </div>
    <section v-show="showResults" tw-class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4" data-testid="workflow-results">
      <div tw-class="flex flex-wrap items-center gap-2"><h2 tw-class="font-semibold flex-1">{{ status }}</h2><button type="button" :disabled="workspace.busy.value || workspace.running.value || !workspace.hasResults.value" @click="workspace.openResults({ zip: false })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__open_results() }}</button><button type="button" :disabled="workspace.busy.value || workspace.running.value || !workspace.hasResults.value" @click="workspace.openResults({ zip: true })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><DownloadIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__download_zip() }}</button><button type="button" :disabled="workspace.busy.value || workspace.running.value || !workspace.hasResults.value" @click="workspace.clearResults({ confirm: true })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.workflow__clear_results() }}</button></div>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__run_notice() }}</p>
      <div v-if="workspace.pending.value" tw-class="rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 p-4 space-y-3" role="group" :aria-label="workspace.pending.value.title">
        <h3 tw-class="font-semibold">{{ workspace.pending.value.title }}</h3><pre tw-class="whitespace-pre-wrap text-sm font-sans break-words">{{ workspace.pending.value.prompt }}</pre>
        <template v-if="workspace.pending.value.kind === 'approval'"><button type="button" @click="workspace.respond({ token: workspace.pending.value.token, text: 'allow' })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.workflow__allow() }}</button><button type="button" @click="workspace.respond({ token: workspace.pending.value.token, text: 'deny' })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 ml-2">{{ lazyStrings.workflow__deny() }}</button></template>
        <template v-else><textarea v-model="response" rows="4" tw-class="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 p-3 text-sm" :aria-label="lazyStrings.workflow__input_response()" /><button type="button" @click="workspace.respond({ token: workspace.pending.value.token, text: response })" tw-class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.workflow__continue() }}</button></template>
      </div>
      <div v-if="workspace.writtenFiles.value.length" tw-class="space-y-2 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__written_files() }}</p>
        <div v-for="file in workspace.writtenFiles.value" :key="idToRaw({ id: file.volumeId }) + '/' + file.relativePath" tw-class="flex items-center gap-2 text-xs">
          <span tw-class="flex-1 min-w-0 break-all">{{ file.relativePath }}</span>
          <button type="button" :disabled="workspace.busy.value" @click="workspace.openWrittenFile({ file })" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40" :aria-label="lazyStrings.workflow__open_folder()"><FolderOpenIcon tw-class="w-4 h-4" /></button>
        </div>
      </div>
      <p tw-class="text-[10px] text-gray-400">{{ lazyStrings.workflow__preview_limit() }}</p>
      <article v-for="entry in workspace.log.value" :key="entry.number" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-3">
        <header tw-class="flex gap-2 text-xs"><span tw-class="text-gray-400 tabular-nums">{{ entry.number }}</span><strong tw-class="flex-1">{{ entry.name }}</strong><span tw-class="text-gray-400">{{ entry.trace.join(' / ') }}</span><span :tw-class="entry.phase === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-500 motion-safe:animate-pulse'">{{ entry.phase === 'completed' ? lazyStrings.workflow__completed() : lazyStrings.workflow__running() }}</span></header>
        <WorkflowDisclosure v-if="entry.inputPreview" :title="lazyStrings.workflow__input_preview()"><pre tw-class="max-h-64 overflow-auto text-xs leading-relaxed whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{{ entry.inputPreview }}</pre></WorkflowDisclosure>
        <div v-if="entry.preview" tw-class="space-y-1"><p tw-class="text-xs font-medium text-gray-500">{{ lazyStrings.workflow__output_preview() }}</p><pre data-testid="workflow-live-output" tw-class="max-h-64 overflow-auto text-xs leading-relaxed whitespace-pre-wrap break-words text-gray-700 dark:text-gray-200">{{ entry.preview }}</pre></div>
      </article>
    </section>
  </main>
</template>
