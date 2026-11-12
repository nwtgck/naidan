<script setup lang="ts">
import { useId } from 'vue';
import { lazyStrings, ensureStrings } from '@/strings';
import { useConfirm } from '@/composables/useConfirm';
import type { ImageCompositionEditor } from '@/features/image-generation/composition/use-image-composition';
import ImageCompositionFields from './ImageCompositionFields.vue';
const props = defineProps<{ editor: ImageCompositionEditor, shared: Record<string, unknown>, supported: boolean, running: boolean, stopping: boolean, progress: { index: number, total: number, phase: string } | undefined }>();
const emit = defineEmits<{ generate: [], cancel: [], forceCancel: [], sharedNegativePrompt: [value: string] }>();
const { showConfirm } = useConfirm();
const id = useId();

async function replace(): Promise<void> {
  if (props.editor.state.value.jobs.length && !await showConfirm({ message: await ensureStrings.imageComposition__replace_notice() })) {
    return;
  }
  props.editor.importJobs({ replace: true });
}

async function reload(): Promise<void> {
  if (!await showConfirm({ message: await ensureStrings.imageComposition__reload_notice() })) {
    return;
  }
  props.editor.reload();
}

function sharedNegativePrompt({ event }: { event: Event }): void {
  if (props.editor.editable.value && event.target instanceof HTMLTextAreaElement) {
    emit('sharedNegativePrompt', event.target.value);
  }
}

function pasteText({ event }: { event: Event }): void {
  if (event.target instanceof HTMLTextAreaElement) {
    props.editor.setPastedText({ text: event.target.value });
  }
}

function prompt({ jobId, event }: { jobId: string, event: Event }): void {
  if (!(event.target instanceof HTMLTextAreaElement)) {
    return;
  }
  const job = props.editor.state.value.jobs.find(job => job.id === jobId);
  if (job) {
    props.editor.update({ id: jobId, input: { ...job.input, prompt: event.target.value } });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="image-composition-editor" tw-class="space-y-3">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__help() }}</p>
    <div tw-class="space-y-1">
      <label :for="id + '-shared-negative'" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.imageComposition__shared_negative_prompt() }}</label>
      <textarea :id="id + '-shared-negative'" :value="String(shared.negativePrompt ?? '')" :disabled="!editor.editable.value" @input="sharedNegativePrompt({ event: $event })" rows="2" maxlength="4096" data-testid="composition-shared-negative" tw-class="w-full resize-y rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
    <div tw-class="flex flex-wrap gap-2">
      <button type="button" data-testid="composition-add" :disabled="!editor.editable.value || editor.state.value.jobs.length >= 128" @click="editor.add()" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.imageComposition__add() }}</button>
      <button type="button" data-testid="composition-paste" :disabled="!editor.editable.value" @click="editor.toggleImport()" :aria-expanded="editor.importOpen.value" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageComposition__paste() }}</button>
    </div>
    <section v-if="editor.importOpen.value" tw-class="rounded-xl border border-blue-200 dark:border-blue-900 p-3 space-y-3" data-testid="composition-paste-panel">
      <label :for="id + '-paste'" tw-class="text-sm font-medium">{{ lazyStrings.imageComposition__paste() }}</label>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__paste_help() }}</p>
      <textarea :id="id + '-paste'" :value="editor.pastedText.value" @input="pasteText({ event: $event })" :disabled="!editor.editable.value" rows="9" spellcheck="false" data-testid="composition-paste-text" tw-class="block w-full resize-y rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-blue-500" />
      <button type="button" :disabled="!editor.editable.value || editor.parsing.value" @click="editor.parse()" data-testid="composition-parse" tw-class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.imageComposition__parse() }}</button>
      <div v-if="editor.preview.value" tw-class="space-y-2">
        <p role="status" tw-class="text-xs">{{ editor.preview.value.format }} · {{ editor.preview.value.inputs.length }}</p>
        <ol tw-class="max-h-48 list-decimal overflow-auto pl-5 text-xs space-y-1"><li v-for="(input, index) in editor.preview.value.inputs" :key="index" tw-class="whitespace-pre-wrap break-words">{{ input.prompt }}<span tw-class="font-mono text-gray-500"> {{ input.uiModelConfigurationSlot }}</span></li></ol>
        <div tw-class="flex flex-wrap gap-2"><button type="button" @click="editor.importJobs({ replace: false })" data-testid="composition-import" :disabled="!editor.editable.value" tw-class="rounded-lg bg-blue-600 px-3 py-2 text-xs text-white disabled:opacity-40">{{ lazyStrings.imageComposition__append() }}</button><button type="button" @click="replace" :disabled="!editor.editable.value" tw-class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.imageComposition__replace() }}</button></div>
      </div>
      <p v-if="editor.importFailure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ editor.importFailure.value }}</p>
    </section>
    <section v-if="editor.slotNames.value.length" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid="composition-slots">
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__slot_help() }}</p>
      <div v-for="name in editor.slotNames.value" :key="name" tw-class="space-y-1 border-t border-gray-200 dark:border-gray-700 pt-2">
        <p tw-class="break-words text-xs font-mono">{{ name }} · {{ editor.state.value.slots.some(slot => slot.name === name) ? lazyStrings.imageComposition__assigned() : lazyStrings.imageComposition__unassigned() }}</p>
        <p v-if="editor.state.value.slots.find(slot => slot.name === name)" tw-class="text-xs break-words text-gray-500 dark:text-gray-400">{{ editor.state.value.slots.find(slot => slot.name === name)?.configuration.request.models.map(model => model.file.name).join(' / ') }}<span v-if="editor.state.value.slots.find(slot => slot.name === name)?.configuration.request.loras.length"> · LoRA: {{ editor.state.value.slots.find(slot => slot.name === name)?.configuration.request.loras.map(lora => lora.file.name + ' (' + lora.strength + ')').join(', ') }}</span></p>
        <button type="button" :disabled="!editor.editable.value" @click="editor.assignSlot({ name })" tw-class="rounded-lg px-2 py-1.5 text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageComposition__assign() }}</button>
      </div>
    </section>
    <section v-for="(job, index) in editor.state.value.jobs" :key="job.id" data-testid="composition-job" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
      <div tw-class="flex flex-wrap items-center gap-2 text-xs"><span tw-class="mr-auto font-medium">{{ index + 1 }}</span>
        <button type="button" @click="editor.move({ id: job.id, delta: -1 })" :disabled="!editor.editable.value || index === 0" :aria-label="lazyStrings.imageComposition__up()" tw-class="rounded px-2 py-1 disabled:opacity-40">↑</button>
        <button type="button" @click="editor.move({ id: job.id, delta: 1 })" :disabled="!editor.editable.value || index === editor.state.value.jobs.length - 1" :aria-label="lazyStrings.imageComposition__down()" tw-class="rounded px-2 py-1 disabled:opacity-40">↓</button>
        <button type="button" @click="editor.duplicate({ id: job.id })" :disabled="!editor.editable.value || editor.state.value.jobs.length >= 128" tw-class="rounded px-2 py-1 disabled:opacity-40">{{ lazyStrings.imageComposition__duplicate() }}</button>
        <button type="button" @click="editor.remove({ id: job.id })" :disabled="!editor.editable.value" tw-class="rounded px-2 py-1 text-red-600 dark:text-red-400 disabled:opacity-40">{{ lazyStrings.imageComposition__remove() }}</button>
      </div>
      <label :for="id + job.id" tw-class="block text-xs">{{ lazyStrings.stableDiffusionCppBrowser__prompt() }}</label>
      <textarea :id="id + job.id" :value="job.input.prompt" :disabled="!editor.editable.value" @input="prompt({ jobId: job.id, event: $event })" rows="3" maxlength="4096" data-testid="composition-prompt" tw-class="w-full resize-y rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
      <details><summary tw-class="cursor-pointer text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.imageComposition__overrides() }} · {{ Object.keys(job.input).length - 1 }}</summary><div tw-class="pt-3"><ImageCompositionFields :input="job.input" :disabled="!editor.editable.value" :shared="shared" @update="editor.update({ id: job.id, input: $event })" /></div></details>
    </section>
    <p v-if="editor.loading.value" role="status" tw-class="text-xs">{{ lazyStrings.imageGeneration__loading() }}</p>
    <p v-if="editor.failure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ editor.failure.value }}</p>
    <button v-if="editor.failure.value && !editor.loading.value" type="button" @click="editor.flush()" :disabled="editor.saving.value" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.imageGeneration__save_retry() }}</button>
    <button v-if="editor.failure.value" type="button" @click="reload" :disabled="editor.saving.value || running" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.imageComposition__reload() }}</button>
    <p tw-class="text-xs" role="status">{{ lazyStrings.imageComposition__summary({ requests: editor.state.value.jobs.length, images: editor.validation.value.images }) }}</p>
    <details v-if="editor.validation.value.issues.length && editor.state.value.jobs.length" tw-class="text-xs text-amber-700 dark:text-amber-300"><summary>{{ lazyStrings.stableDiffusionCppBrowser__check_inputs() }}</summary><p v-for="issue in editor.validation.value.issues" :key="issue" tw-class="break-words">{{ issue }}</p></details>
    <p v-if="!supported" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__unsupported() }}</p>
    <div tw-class="flex flex-wrap gap-2">
      <button type="button" @click="emit('generate')" data-testid="composition-generate" :disabled="!editor.editable.value || !supported || !!editor.validation.value.issues.length" tw-class="min-h-11 flex-1 rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-gray-800 px-4 py-2 text-sm font-semibold disabled:opacity-40">{{ lazyStrings.imageComposition__generate() }}</button>
      <button type="button" @click="emit('cancel')" :disabled="!running || stopping" tw-class="rounded-xl border border-gray-300 dark:border-gray-700 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__cancel() }}</button>
      <button v-if="stopping" type="button" @click="emit('forceCancel')" tw-class="rounded-xl border border-red-300 dark:border-red-900 px-3 py-2 text-xs text-red-600 dark:text-red-400">{{ lazyStrings.stableDiffusionCppBrowser__force_stop() }}</button>
    </div>
    <p v-if="progress" role="status" tw-class="text-xs">{{ progress.index }} / {{ progress.total }}</p>
  </section>
</template>
