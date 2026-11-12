<script setup lang="ts">
import { useId } from 'vue';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ClipboardPasteIcon, CopyIcon, ImageIcon, LayersIcon, OctagonXIcon, PlusIcon, RefreshCwIcon, ReplaceIcon, SquareIcon, Trash2Icon } from 'lucide-vue-next';
import { lazyStrings, ensureStrings } from '@/strings';
import { useConfirm } from '@/composables/useConfirm';
import ActionButton from '@/components/ActionButton.vue';
import type { ImageCompositionEditor } from '@/features/image-generation/composition/use-image-composition';
import ImageCompositionFields from './ImageCompositionFields.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
const props = defineProps<{ editor: ImageCompositionEditor, shared: Record<string, unknown>, supported: boolean, running: boolean, stopping: boolean, progress: { index: number, total: number, phase: string } | undefined }>();
const emit = defineEmits<{ generate: [], cancel: [], forceCancel: [], sharedNegativePrompt: [value: string] }>();
defineSlots<{ 'input-mode'(): unknown }>();
const { showConfirm } = useConfirm();
const id = useId();
const inputExamples = {
  YAML: `\
prompt: A red-haired character in a forest
negativePrompt: blurry, low quality
count: 2
seed: null
steps: auto
---
prompt: A blue-haired character in a forest
count: 1
seed: "42"
`,
  JSONL: `\
{"prompt":"A red-haired character in a forest","negativePrompt":"blurry, low quality","count":2,"seed":null,"steps":"auto"}
{"prompt":"A blue-haired character in a forest","count":1,"seed":"42"}
`,
};

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
    <div tw-class="flex flex-wrap items-center gap-2">
      <slot name="input-mode" />
      <div tw-class="ml-auto flex items-center gap-1.5">
        <ActionButton data-testid="composition-add" :disabled="!editor.editable.value || editor.state.value.jobs.length >= 128" appearance="primary" icon-tone="blue" @click="editor.add()"><PlusIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.imageComposition__add() }}</ActionButton>
        <button type="button" data-testid="composition-paste" :disabled="!editor.editable.value" @click="editor.toggleImport()" :aria-expanded="editor.importOpen.value" :aria-controls="id + '-paste-panel'" :aria-label="lazyStrings.imageComposition__paste()" :title="lazyStrings.imageComposition__paste()" :tw-class="['inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-lg border p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40', editor.importOpen.value ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400' : 'border-gray-200/80 bg-white/70 text-gray-500 enabled:hover:border-blue-200 enabled:hover:bg-blue-50/60 enabled:hover:text-blue-600 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-400 dark:enabled:hover:border-blue-500/30 dark:enabled:hover:bg-blue-500/10 dark:enabled:hover:text-blue-400']"><ClipboardPasteIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      </div>
    </div>
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__help() }}</p>
    <div tw-class="rounded-xl border border-gray-200/80 bg-gray-50/70 px-3.5 pb-1.5 pt-2 transition-colors hover:border-gray-300 focus-within:border-blue-400/70 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/20 dark:hover:border-gray-600 dark:focus-within:border-blue-500/60">
      <label :for="id + '-shared-negative'" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.imageComposition__shared_negative_prompt() }}</label>
      <textarea :id="id + '-shared-negative'" :value="String(shared.negativePrompt ?? '')" :disabled="!editor.editable.value" @input="sharedNegativePrompt({ event: $event })" rows="2" maxlength="4096" data-testid="composition-shared-negative" tw-class="block w-full resize-y border-0 bg-transparent px-0.5 py-2 text-sm leading-7 text-gray-800 outline-none disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-100" />
    </div>
    <section v-if="editor.importOpen.value" :id="id + '-paste-panel'" tw-class="space-y-3 rounded-xl border border-gray-200/80 bg-gray-50/60 p-3 dark:border-gray-700/70 dark:bg-gray-800/20" data-testid="composition-paste-panel">
      <div tw-class="space-y-1"><label :for="id + '-paste'" tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.imageComposition__paste() }}</label><p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__paste_help() }}</p></div>
      <ImageSettingsSection :title="lazyStrings.imageComposition__input_examples()" :summary="undefined" compact embedded data-testid="composition-input-examples">
        <p tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.imageComposition__input_structure_help() }}</p>
        <section v-for="(example, format) in inputExamples" :key="format" :aria-label="format" tw-class="min-w-0 space-y-1">
          <header tw-class="flex items-center justify-between gap-2"><h4 tw-class="font-mono text-xs font-semibold text-gray-600 dark:text-gray-300">{{ format }}</h4><ImageGenerationCopyButton :text="example" :label="lazyStrings.imageComposition__copy_example({ format })" :data-testid="'composition-copy-example-' + format" /></header>
          <pre tabindex="0" :aria-label="format" tw-class="max-w-full overflow-x-auto rounded-lg border border-gray-200/70 bg-white/80 px-3 py-2.5 font-mono text-xs leading-6 text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-gray-700/60 dark:bg-gray-900/60 dark:text-gray-300"><code :data-testid="'composition-input-example-code-' + format">{{ example }}</code></pre>
        </section>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__input_values_help() }}</p>
        <div tw-class="space-y-1.5"><p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__input_models_help() }}</p><div v-for="format in ['YAML', 'JSONL'] as const" :key="format" tw-class="space-y-1"><span tw-class="font-mono text-xs text-gray-500 dark:text-gray-400">{{ format }}</span><code tw-class="block max-w-full overflow-x-auto rounded-md bg-gray-100/70 px-2 py-1.5 font-mono text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">{{ format === 'YAML' ? 'uiModelConfigurationSlot: "illustration"' : '"uiModelConfigurationSlot": "illustration"' }}</code></div></div>
      </ImageSettingsSection>
      <textarea :id="id + '-paste'" :value="editor.pastedText.value" @input="pasteText({ event: $event })" :disabled="!editor.editable.value" rows="9" spellcheck="false" data-testid="composition-paste-text" tw-class="block w-full resize-y rounded-xl border border-gray-200/80 bg-white px-3 py-2 font-mono text-xs leading-6 text-gray-800 outline-none transition-colors focus:border-blue-400/70 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-900/60 dark:text-gray-200 dark:focus:border-blue-500/60" />
      <ActionButton :disabled="!editor.editable.value || editor.parsing.value" appearance="primary" icon-tone="blue" @click="editor.parse()" data-testid="composition-parse"><CheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.imageComposition__parse() }}</ActionButton>
      <div v-if="editor.preview.value" tw-class="space-y-2">
        <p role="status" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ editor.preview.value.format }} · {{ editor.preview.value.inputs.length }}</p>
        <ol tw-class="max-h-48 list-decimal space-y-1.5 overflow-auto pl-5 text-sm text-gray-700 dark:text-gray-300"><li v-for="(input, index) in editor.preview.value.inputs" :key="index" tw-class="whitespace-pre-wrap break-words">{{ input.prompt }}<span tw-class="font-mono text-xs text-gray-500 dark:text-gray-400"> {{ input.uiModelConfigurationSlot }}</span></li></ol>
        <div tw-class="flex flex-wrap gap-2"><ActionButton @click="editor.importJobs({ replace: false })" data-testid="composition-import" :disabled="!editor.editable.value" appearance="primary" icon-tone="blue"><PlusIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.imageComposition__append() }}</ActionButton><ActionButton @click="replace" :disabled="!editor.editable.value" appearance="secondary" :icon-tone="undefined"><ReplaceIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.imageComposition__replace() }}</ActionButton></div>
      </div>
      <p v-if="editor.importFailure.value" role="alert" tw-class="break-words text-xs leading-relaxed text-red-600 dark:text-red-400">{{ editor.importFailure.value }}</p>
    </section>
    <section v-if="editor.slotNames.value.length" tw-class="overflow-hidden rounded-xl border border-gray-200/80 bg-gray-50/50 dark:border-gray-700/70 dark:bg-gray-800/20" data-testid="composition-slots">
      <p tw-class="px-3 py-2.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__slot_help() }}</p>
      <div v-for="name in editor.slotNames.value" :key="name" tw-class="space-y-2 border-t border-gray-200/70 px-3 py-2.5 dark:border-gray-700/60">
        <div tw-class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><p tw-class="min-w-0 break-words font-mono text-xs text-gray-700 dark:text-gray-300">{{ name }}</p><span :tw-class="['text-xs', editor.state.value.slots.some(slot => slot.name === name) ? 'text-gray-500 dark:text-gray-400' : 'font-medium text-amber-700 dark:text-amber-400']">{{ editor.state.value.slots.some(slot => slot.name === name) ? lazyStrings.imageComposition__assigned() : lazyStrings.imageComposition__unassigned() }}</span></div>
        <p v-if="editor.state.value.slots.find(slot => slot.name === name)" tw-class="break-words text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ editor.state.value.slots.find(slot => slot.name === name)?.configuration.request.models.map(model => model.file.name).join(' / ') }}<span v-if="editor.state.value.slots.find(slot => slot.name === name)?.configuration.request.loras.length"> · LoRA: {{ editor.state.value.slots.find(slot => slot.name === name)?.configuration.request.loras.map(lora => lora.file.name + ' (' + lora.strength + ')').join(', ') }}</span></p>
        <ActionButton :disabled="!editor.editable.value" appearance="primary" icon-tone="blue" @click="editor.assignSlot({ name })"><LayersIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.imageComposition__assign() }}</ActionButton>
      </div>
    </section>
    <section v-for="(job, index) in editor.state.value.jobs" :key="job.id" data-testid="composition-job" tw-class="overflow-hidden rounded-xl border border-gray-200/80 bg-white transition-colors hover:border-gray-300 focus-within:border-blue-400/70 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-900/40 dark:hover:border-gray-600 dark:focus-within:border-blue-500/60">
      <div tw-class="space-y-1 px-3 py-2.5">
        <div tw-class="flex flex-wrap items-center justify-between gap-2">
          <label :for="id + job.id" tw-class="inline-flex min-w-0 items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300"><span tw-class="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-gray-100 px-1 text-[11px] font-medium tabular-nums text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ index + 1 }}</span>{{ lazyStrings.stableDiffusionCppBrowser__prompt() }}</label>
          <div tw-class="ml-auto flex items-center gap-0.5">
            <button type="button" @click="editor.move({ id: job.id, delta: -1 })" :disabled="!editor.editable.value || index === 0" :aria-label="lazyStrings.imageComposition__up()" :title="lazyStrings.imageComposition__up()" tw-class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors enabled:hover:bg-gray-100 enabled:hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-35 dark:text-gray-400 dark:enabled:hover:bg-gray-800 dark:enabled:hover:text-gray-200"><ArrowUpIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
            <button type="button" @click="editor.move({ id: job.id, delta: 1 })" :disabled="!editor.editable.value || index === editor.state.value.jobs.length - 1" :aria-label="lazyStrings.imageComposition__down()" :title="lazyStrings.imageComposition__down()" tw-class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors enabled:hover:bg-gray-100 enabled:hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-35 dark:text-gray-400 dark:enabled:hover:bg-gray-800 dark:enabled:hover:text-gray-200"><ArrowDownIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
            <span aria-hidden="true" tw-class="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-700" />
            <button type="button" @click="editor.duplicate({ id: job.id })" :disabled="!editor.editable.value || editor.state.value.jobs.length >= 128" :aria-label="lazyStrings.imageComposition__duplicate()" :title="lazyStrings.imageComposition__duplicate()" tw-class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors enabled:hover:bg-blue-50 enabled:hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-35 dark:text-gray-400 dark:enabled:hover:bg-blue-500/10 dark:enabled:hover:text-blue-400"><CopyIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
            <button type="button" @click="editor.remove({ id: job.id })" :disabled="!editor.editable.value" :aria-label="lazyStrings.imageComposition__remove()" :title="lazyStrings.imageComposition__remove()" tw-class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors enabled:hover:bg-red-50 enabled:hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-35 dark:text-gray-500 dark:enabled:hover:bg-red-500/10 dark:enabled:hover:text-red-400"><Trash2Icon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
          </div>
        </div>
        <textarea :id="id + job.id" :value="job.input.prompt" :disabled="!editor.editable.value" @input="prompt({ jobId: job.id, event: $event })" rows="3" maxlength="4096" data-testid="composition-prompt" tw-class="block w-full resize-y border-0 bg-transparent px-0.5 py-1.5 text-sm leading-7 text-gray-800 outline-none disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-100" />
      </div>
      <div tw-class="border-t border-gray-100 px-2.5 py-2 dark:border-gray-800"><ImageSettingsSection :title="lazyStrings.imageComposition__overrides()" :summary="String(Object.keys(job.input).length - 1)" embedded compact><ImageCompositionFields :input="job.input" :disabled="!editor.editable.value" :shared="shared" @update="editor.update({ id: job.id, input: $event })" /></ImageSettingsSection></div>
    </section>
    <p v-if="editor.loading.value" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__loading() }}</p>
    <p v-if="editor.failure.value" role="alert" tw-class="break-words text-xs leading-relaxed text-red-600 dark:text-red-400">{{ editor.failure.value }}</p>
    <div v-if="editor.failure.value" tw-class="flex flex-wrap gap-2"><ActionButton v-if="!editor.loading.value" @click="editor.flush()" :disabled="editor.saving.value" appearance="primary" icon-tone="blue"><RefreshCwIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.imageGeneration__save_retry() }}</ActionButton><ActionButton @click="reload" :disabled="editor.saving.value || running" appearance="secondary" :icon-tone="undefined"><RefreshCwIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />{{ lazyStrings.imageComposition__reload() }}</ActionButton></div>
    <p tw-class="text-xs font-medium text-gray-600 dark:text-gray-300" role="status">{{ lazyStrings.imageComposition__summary({ requests: editor.state.value.jobs.length, images: editor.validation.value.images }) }}</p>
    <ImageSettingsSection v-if="editor.validation.value.issues.length && editor.state.value.jobs.length" :title="lazyStrings.stableDiffusionCppBrowser__check_inputs()" :summary="String(editor.validation.value.issues.length)" compact><p v-for="issue in editor.validation.value.issues" :key="issue" tw-class="break-words text-xs leading-relaxed text-amber-700 dark:text-amber-300">{{ issue }}</p></ImageSettingsSection>
    <p v-if="!supported" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageComposition__unsupported() }}</p>
    <div tw-class="flex flex-wrap gap-2">
      <button type="button" @click="emit('generate')" data-testid="composition-generate" :disabled="!editor.editable.value || !supported || !!editor.validation.value.issues.length" tw-class="inline-flex min-h-11 flex-1 items-center justify-center gap-2.5 rounded-xl border border-blue-300/80 bg-blue-50/60 px-4 py-2.5 text-sm font-semibold text-gray-800 transition-colors enabled:hover:border-blue-400 enabled:hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-100 dark:enabled:hover:border-blue-400/60 dark:enabled:hover:bg-gray-800"><ImageIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ lazyStrings.imageComposition__generate() }}</button>
      <button type="button" @click="emit('cancel')" :disabled="!running || stopping" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors enabled:hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:enabled:hover:bg-gray-700"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5 fill-current" />{{ lazyStrings.stableDiffusionCppBrowser__cancel() }}</button>
      <button v-if="stopping" type="button" @click="emit('forceCancel')" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40"><OctagonXIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.stableDiffusionCppBrowser__force_stop() }}</button>
    </div>
    <p v-if="progress" role="status" tw-class="text-xs tabular-nums text-gray-500 dark:text-gray-400">{{ progress.index }} / {{ progress.total }}</p>
  </section>
</template>
