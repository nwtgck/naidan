<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ArrowLeftRightIcon, DicesIcon, ChevronDownIcon, ImageIcon, SquareIcon, OctagonXIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { profileOptions, samplerOptions, schedulerOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import ImageModelLibrary from '@/features/stable-diffusion-cpp-browser/components/ImageModelLibrary.vue';
import ImageModelConfiguration from '@/features/stable-diffusion-cpp-browser/components/ImageModelConfiguration.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageLoraControls from '@/features/stable-diffusion-cpp-browser/components/ImageLoraControls.vue';
import ImageInputControls from './ImageInputControls.vue';
import ImageExecutionTarget from './ImageExecutionTarget.vue';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
const props = defineProps<{ view: ImageGenerationView, active: boolean }>();
defineSlots<{ 'prompt-actions'({ field, text }: { field: 'prompt' | 'negativePrompt', text: string }): unknown }>();
const emit = defineEmits<{ manageModels: [] }>();
const id = useId();
const configurationOpen = ref(false);
const { seedMode, randomizeSeed, retainModel, modelResident, profile, layout, files, loras, imageInputs, parameters, weightResidency, gpuBudgetMiB, invalid, cancelled, stopping, progress, recommendation, manualInspectionState, library, busy, supported, formDisabled, draftDisabled, chooseFile, resetFiles, generate, cancel, forceCancel, releaseModel, applyRecommendedSettings } = props.view;
const inferenceRunning = computed(() => busy.value && progress.value !== undefined);
const remote = computed(() => props.view.executionTarget?.kind.value === 'naidan_rpc');
const hasModel = computed(() => remote.value ? !!props.view.executionTarget?.selection.value && !!props.view.executionTarget?.connected.value : !!library.main.value || !!files.value.model || !!files.value.diffusion);
const slots = computed(() => {
  switch (layout.value) {
  case 'checkpoint': return [{ slot: 'model' as const, label: lazyStrings.stableDiffusionCppBrowser__model_file() }];
  case 'components': return [
    { slot: 'diffusion' as const, label: lazyStrings.stableDiffusionCppBrowser__diffusion_file() },
    { slot: 'vae' as const, label: lazyStrings.stableDiffusionCppBrowser__vae_file() },
    { slot: 'clipL' as const, label: lazyStrings.stableDiffusionCppBrowser__clip_l_file() },
    { slot: 'clipG' as const, label: lazyStrings.stableDiffusionCppBrowser__clip_g_file() },
    { slot: 't5' as const, label: lazyStrings.stableDiffusionCppBrowser__t5_file() },
    { slot: 'lm' as const, label: lazyStrings.stableDiffusionCppBrowser__lm_file() },
  ];
  default: { const exhaustive: never = layout.value;
    throw new Error(String(exhaustive));
  }
  }
});
const weightResidencyOptions = computed(() => [
  { value: 'auto' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_auto() },
  { value: 'cpu' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_cpu() },
  { value: 'hybrid' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_hybrid() },
  { value: 'disk' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_disk() },
]);
const resolutions = [{ width: 256, height: 256 }, { width: 512, height: 512 }, { width: 768, height: 768 }, { width: 1024, height: 1024 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }];
function setResolution({ width, height }: { width: number, height: number }): void {
  if (draftDisabled.value) return;
  parameters.value.width = width;
  parameters.value.height = height;
}
const resolutionKey = computed(() => resolutions.some(size => size.width === parameters.value.width && size.height === parameters.value.height) ? `${parameters.value.width}x${parameters.value.height}` : 'custom');
function chooseResolution({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  const size = resolutions.find(size => `${size.width}x${size.height}` === value);
  if (size) setResolution(size);
}
function changeSeed({ event }: { event: Event }): void {
  if (draftDisabled.value || !(event.target instanceof HTMLInputElement)) return;
  parameters.value.seed = event.target.value;
  seedMode.value = 'fixed';
}
function swapResolution(): void {
  setResolution({ width: parameters.value.height, height: parameters.value.width });
}
const resolutionInvalid = computed(() => ![parameters.value.width, parameters.value.height].every(value => Number.isInteger(value) && value >= 128 && value <= 2048 && value % 64 === 0));
const componentSummary = computed(() => library.components.value.map(component => component.choices.find(choice => choice.id === component.selected)?.label).filter(Boolean).join(' · '));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <form @submit.prevent="generate()" tw-class="min-w-0 space-y-4">
    <ImageExecutionTarget v-if="view.executionTarget" :target="view.executionTarget" :disabled="busy || view.historyActions.busy.value" />
    <section v-if="!remote" :aria-label="lazyStrings.stableDiffusionCppBrowser__selected_model()" tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-4 space-y-3" data-testid="image-model-setup">
      <ImageModelLibrary :active="active" :manual-name="(files.model || files.diffusion)?.name" :view="library" :disabled="formDisabled" @prepare="emit('manageModels')" />
      <fieldset :disabled="formDisabled" tw-class="min-w-0 space-y-2" data-testid="image-model-options">
        <ImageSettingsSection embedded v-model:open="configurationOpen" :title="lazyStrings.ImageGenerationEditor__model_configuration()" :summary="componentSummary" data-testid="image-component-settings">
          <ImageModelConfiguration :active="active" :view="library" :disabled="formDisabled" />
          <ImageLoraControls :active="active" embedded v-model="loras" :saved="library.savedLoras.value" :disabled="formDisabled || !supported || library.importing.value" />
          <ImageSettingsSection :title="lazyStrings.stableDiffusionCppBrowser__manual_model_files()" :summary="(files.model || files.diffusion)?.name" data-testid="image-manual-settings">
            <label tw-class="block text-sm space-y-1">
              <span>{{ lazyStrings.stableDiffusionCppBrowser__model_layout() }}</span>
              <span tw-class="relative block"><select v-model="layout" :disabled="library.importing.value" @change="resetFiles" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600">
                <option value="checkpoint">{{ lazyStrings.stableDiffusionCppBrowser__checkpoint() }}</option>
                <option value="components">{{ lazyStrings.stableDiffusionCppBrowser__separate_components() }}</option>
              </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
            </label>
            <div v-for="item in slots" :key="layout + item.slot" tw-class="space-y-1">
              <label :for="id + item.slot" tw-class="block text-sm">{{ item.label }}</label>
              <input :id="id + item.slot" :disabled="library.importing.value" type="file" accept=".gguf,.safetensors,.sft" @change="chooseFile({ slot: item.slot, event: $event })" tw-class="file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 dark:file:bg-blue-950/40 dark:file:text-blue-300 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full text-sm" :data-testid="'image-file-' + item.slot" />
            </div>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__companion_files_help() }}</p>

          </ImageSettingsSection>
        </ImageSettingsSection>
      </fieldset>
    </section>
    <section tw-class="space-y-2" data-testid="image-prompt-section">
      <div tw-class="flex items-center justify-between gap-2"><label :for="id + '-prompt'" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.stableDiffusionCppBrowser__prompt() }}</label><div tw-class="flex items-center gap-1"><slot name="prompt-actions" :field="'prompt'" :text="parameters.prompt" /><ImageGenerationCopyButton :text="parameters.prompt" :label="lazyStrings.imageGeneration__copy_prompt()" data-testid="image-copy-draft-prompt" /></div></div>
      <textarea :id="id + '-prompt'" :placeholder="lazyStrings.stableDiffusionCppBrowser__prompt()" :disabled="draftDisabled" v-model="parameters.prompt" rows="4" maxlength="4096" required data-testid="image-prompt" tw-class="block w-full resize-y rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-base leading-relaxed text-gray-800 dark:text-gray-100 shadow-sm outline-none transition-all hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 placeholder:text-gray-400 disabled:opacity-50 disabled:cursor-not-allowed" />
      <div tw-class="flex items-center justify-between gap-2"><label :for="id + '-negative-prompt'" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.stableDiffusionCppBrowser__negative_prompt() }}</label><div tw-class="flex items-center gap-1"><slot name="prompt-actions" :field="'negativePrompt'" :text="parameters.negativePrompt" /><ImageGenerationCopyButton :text="parameters.negativePrompt" :label="lazyStrings.imageGeneration__copy_negative_prompt()" data-testid="image-copy-draft-negative-prompt" /></div></div>
      <textarea :id="id + '-negative-prompt'" :disabled="draftDisabled" :placeholder="lazyStrings.stableDiffusionCppBrowser__negative_prompt()" v-model="parameters.negativePrompt" rows="1" maxlength="4096" data-testid="image-negative-prompt" tw-class="block w-full resize-y rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 text-sm text-gray-800 dark:text-gray-100 shadow-sm outline-none transition-all hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 placeholder:text-gray-400 disabled:opacity-50 disabled:cursor-not-allowed" />
      <div tw-class="flex flex-wrap items-center gap-2" data-testid="image-generation-actions">
        <button type="submit" :disabled="formDisabled || !supported || !hasModel || (!remote && (library.importing.value || (!!library.main.value && !library.ready.value)))" data-testid="image-generate" tw-class="flex-1 min-h-11 flex items-center justify-center gap-2 rounded-xl md:rounded-2xl px-5 py-2.5 bg-blue-600 text-white hover:bg-blue-700 text-sm font-bold shadow-lg shadow-blue-500/30 transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none motion-reduce:transition-none motion-reduce:transform-none"><ImageIcon aria-hidden="true" tw-class="w-4 h-4" />{{ lazyStrings.stableDiffusionCppBrowser__generate() }}</button>

        <button type="button" :disabled="!inferenceRunning || stopping" @click="cancel" data-testid="image-cancel" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-bold text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">
          <SquareIcon aria-hidden="true" tw-class="h-4 w-4 fill-current" />{{ lazyStrings.stableDiffusionCppBrowser__cancel() }}</button>
        <button v-if="stopping" type="button" :disabled="!inferenceRunning" @click="forceCancel" data-testid="image-force-cancel" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm font-bold text-red-700 dark:text-red-300 shadow-sm hover:border-red-300 dark:hover:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-40 disabled:cursor-not-allowed">
          <OctagonXIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.stableDiffusionCppBrowser__force_stop() }}</button>

      </div>
      <p v-if="busy" data-testid="image-next-generation-draft" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationEditor__edits_apply_to_next_generation() }}</p>
      <div v-if="cancelled" tw-class="flex flex-wrap items-center justify-between gap-2">
        <p v-if="cancelled" role="status" tw-class="text-sm">{{ lazyStrings.stableDiffusionCppBrowser__cancelled() }}</p>
      </div>
      <p v-if="stopping" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__cancel_wait_help() }}</p>
      <p v-if="invalid" role="alert" tw-class="text-red-600 dark:text-red-400 text-sm">{{ lazyStrings.stableDiffusionCppBrowser__check_inputs() }}</p>
    </section>
    <fieldset :disabled="draftDisabled" tw-class="min-w-0 space-y-4">
      <ImageInputControls :active="active" v-model="imageInputs" :disabled="formDisabled || !supported || library.importing.value" />
      <section tw-class="space-y-2" data-testid="image-resolution">
        <div tw-class="flex flex-wrap items-end gap-2">
          <label tw-class="min-w-32 flex-1 text-xs space-y-1">
            <span>{{ lazyStrings.ImageGenerationEditor__image_size() }}</span>
            <span tw-class="relative block"><select :value="resolutionKey" @change="chooseResolution({ event: $event })" data-testid="image-resolution-presets" tw-class="appearance-none cursor-pointer pr-9 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600 text-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10">
              <option value="custom">{{ lazyStrings.ImageGenerationEditor__custom_size() }}</option>
              <option v-for="size in resolutions" :key="size.width + 'x' + size.height" :value="size.width + 'x' + size.height">{{ size.width }} × {{ size.height }}</option>
            </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
          </label>
          <label tw-class="w-20 text-xs space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__width() }}</span><input v-model.number="parameters.width" type="number" min="128" max="2048" step="64" required data-testid="image-width" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-2 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600 text-sm tabular-nums" /></label>
          <label tw-class="w-20 text-xs space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__height() }}</span><input v-model.number="parameters.height" type="number" min="128" max="2048" step="64" required data-testid="image-height" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-2 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600 text-sm tabular-nums" /></label>
          <button type="button" @click="swapResolution" data-testid="image-swap-resolution" :aria-label="lazyStrings.ImageGenerationEditor__swap_width_and_height()" :title="lazyStrings.ImageGenerationEditor__swap_width_and_height()" tw-class="inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-600 dark:text-gray-300 shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><ArrowLeftRightIcon tw-class="w-4 h-4" /></button>
        </div>
        <p v-if="resolutionInvalid" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300" data-testid="image-resolution-warning">{{ lazyStrings.ImageGenerationEditor__resolution_must_use_supported_dimensions() }}</p>
      </section>
      <div tw-class="grid grid-cols-2 gap-3">
        <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__steps() }}</span><input v-model.number="parameters.steps" data-testid="image-steps" type="number" min="1" max="100" step="1" required tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600" /></label>
        <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__guidance() }}</span><input v-model.number="parameters.guidance" data-testid="image-guidance" type="number" min="0" max="30" step="0.1" required tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600" /></label>
      </div>
      <div tw-class="space-y-1.5">
        <label :for="id + '-seed'" tw-class="text-sm">{{ lazyStrings.stableDiffusionCppBrowser__seed() }}</label>
        <div tw-class="flex items-stretch gap-2">
          <input :id="id + '-seed'" :value="seedMode === 'random' ? '' : parameters.seed" :readonly="seedMode === 'random'" @input="changeSeed({ event: $event })" :placeholder="seedMode === 'random' ? '—' : undefined" type="text" inputmode="numeric" maxlength="20" :required="seedMode === 'fixed'" data-testid="image-seed" tw-class="min-w-0 flex-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600 text-sm font-mono outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 read-only:bg-gray-50 dark:read-only:bg-gray-800/40" />
          <button type="button" @click="randomizeSeed" :aria-label="lazyStrings.ImageGenerationEditor__pick_new_seed()" data-testid="image-randomize-seed" tw-class="min-h-10 min-w-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-600 dark:text-gray-300 shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><DicesIcon tw-class="w-4 h-4" /></button>
          <span tw-class="relative max-w-[50%]"><select v-model="seedMode" :aria-label="lazyStrings.stableDiffusionCppBrowser__seed()" data-testid="image-seed-mode" tw-class="appearance-none cursor-pointer pr-9 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-2 text-xs text-gray-800 dark:text-gray-100 shadow-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"><option value="random">{{ lazyStrings.ImageGenerationEditor__new_seed_each_time() }}</option><option value="fixed">{{ lazyStrings.ImageGenerationEditor__fixed_seed() }}</option></select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
        </div>
      </div>
    </fieldset>
    <fieldset :disabled="draftDisabled" tw-class="min-w-0 space-y-2">
      <ImageSettingsSection :title="lazyStrings.ImageGenerationEditor__sampling_settings()" :summary="parameters.sampler + ' · ' + parameters.scheduler" data-testid="image-sampling-settings">
        <div tw-class="grid sm:grid-cols-2 gap-3">
          <label tw-class="block text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__sampler() }}</span>
            <span tw-class="relative block"><select v-model="parameters.sampler" data-testid="image-sampler" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600">
              <option v-for="value in samplerOptions" :key="value" :value="value">{{ value }}</option>
            </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
          </label>
          <label tw-class="block text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__scheduler() }}</span>
            <span tw-class="relative block"><select v-model="parameters.scheduler" data-testid="image-scheduler" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600">
              <option v-for="value in schedulerOptions" :key="value" :value="value">{{ value }}</option>
            </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
          </label>
          <label tw-class="text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__distilled_guidance() }}</span>
            <input v-model.number="parameters.distilledGuidance" data-testid="image-distilled-guidance" type="number" min="0" max="30" step="0.1" required tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600" />
          </label>
        </div>
      </ImageSettingsSection>
    </fieldset>
    <fieldset v-if="!remote" :disabled="formDisabled" tw-class="min-w-0 space-y-2">
      <ImageSettingsSection :title="lazyStrings.stableDiffusionCppBrowser__runtime_settings()" :summary="parameters.bf16WeightType.toUpperCase() + ' · ' + profile">
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__advanced_parameters_help() }}</p>
        <div tw-class="grid sm:grid-cols-2 gap-4">
          <label tw-class="block text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__profile() }}</span>
            <span tw-class="relative block"><select v-model="profile" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600">
              <option v-for="value in profileOptions" :key="value" :value="value">{{ value }}</option>
            </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
          </label>
          <label tw-class="block text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__weight_residency() }}</span>
            <span tw-class="relative block"><select v-model="weightResidency" data-testid="image-weight-residency" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600">
              <option v-for="option in weightResidencyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
          </label>
        </div>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__weight_residency_help() }}</p>
        <label tw-class="block text-sm space-y-1">
          <span>{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion() }}</span>
          <span tw-class="relative block"><select v-model="parameters.bf16WeightType" data-testid="image-bf16-weight-type" tw-class="appearance-none cursor-pointer pr-9 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600">
            <option value="f32">F32</option>
            <option value="f16">F16</option>
          </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span>
        </label>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion_help() }}</p>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__memory_and_cancellation() }}</p>
        <label tw-class="block text-sm space-y-1">
          <span>{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget() }}</span>
          <input v-model.number="gpuBudgetMiB" data-testid="image-memory-budget" type="number" min="512" :max="profile === 'webgpu-wasm64-jspi' ? undefined : 4095" step="1" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600" />
        </label>
        <p data-testid="image-memory-budget-help" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget_help() }}</p>
        <div tw-class="grid sm:grid-cols-2 gap-4">
          <label tw-class="text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__conditioning_cache() }}</span>
            <input v-model.number="parameters.conditioningCacheSize" type="number" min="0" max="32" step="1" required tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600" />
          </label>
          <label tw-class="min-h-10 cursor-pointer text-sm flex gap-2 items-center">
            <input v-model="parameters.vaeTiling" type="checkbox" role="switch" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />{{ lazyStrings.stableDiffusionCppBrowser__vae_tiling() }}</label>
          <label tw-class="text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__vae_tile_size() }}</span>
            <input v-model.number="parameters.vaeTileSize" type="number" min="16" max="256" step="8" required tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600" />
          </label>
          <label tw-class="min-h-10 cursor-pointer text-sm flex gap-2 items-center">
            <input v-model="parameters.flashAttention" type="checkbox" role="switch" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />{{ lazyStrings.stableDiffusionCppBrowser__flash_attention() }}</label>
        </div>
        <label tw-class="min-h-10 cursor-pointer text-sm flex gap-2 items-center">
          <input v-model="parameters.qwenVaePolicy" type="checkbox" role="switch" true-value="bounded" false-value="native" data-testid="image-qwen-vae-policy" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />{{ lazyStrings.stableDiffusionCppBrowser__qwen_vae_bounded() }}</label>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__qwen_vae_help() }}</p>
        <label tw-class="block text-sm space-y-1">
          <span>{{ lazyStrings.stableDiffusionCppBrowser__model_arguments() }}</span>
          <input v-model="parameters.modelArguments" type="text" maxlength="4096" placeholder="qwen_image_2_1_prefix_cache=false" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2.5 text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600" />
        </label>
      </ImageSettingsSection>
      <div v-if="recommendation" tw-class="flex items-start gap-2" data-testid="image-recommendation">
        <ImageSettingsSection :title="lazyStrings.stableDiffusionCppBrowser__recommended_settings()" :summary="recommendation.title" tw-class="flex-1 min-w-0">
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__steps() }} {{ recommendation.parameters.steps }} · {{ lazyStrings.stableDiffusionCppBrowser__guidance() }} {{ recommendation.parameters.guidance }} · {{ recommendation.parameters.sampler }}</p>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__recommended_preview_summary() }} {{ recommendation.preview.mode === 'vae' ? lazyStrings.stableDiffusionCppBrowser__preview_vae() : lazyStrings.stableDiffusionCppBrowser__preview_projection() }} · {{ lazyStrings.stableDiffusionCppBrowser__preview_interval() }} {{ recommendation.preview.interval }} · {{ lazyStrings.stableDiffusionCppBrowser__preview_after_step() }} {{ recommendation.preview.startStep }}</p>
          <ImageSettingsSection embedded :title="lazyStrings.stableDiffusionCppBrowser__preset_sources()" :summary="undefined">
            <p tw-class="text-gray-500 dark:text-gray-400 leading-relaxed">{{ lazyStrings.stableDiffusionCppBrowser__preset_policy() }}</p>
            <p v-if="recommendation.id === 'qwen-image-2.1'" tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__qwen_preset_policy() }}</p>
            <p>{{ recommendation.checkedAt }}</p>
            <a v-for="source in recommendation.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" tw-class="block text-blue-600 dark:text-blue-400 underline">{{ source.label }}</a>
          </ImageSettingsSection>
        </ImageSettingsSection>
        <button type="button" @click="applyRecommendedSettings" :disabled="formDisabled || library.importing.value" data-testid="image-apply-recommendation" tw-class="shrink-0 min-h-12 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">{{ lazyStrings.stableDiffusionCppBrowser__apply_recommended_settings() }}</button>
      </div>
      <p v-else-if="manualInspectionState === 'scanning'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__scanning_repositories() }}</p>
      <p v-else-if="library.main.value || files.model || files.diffusion" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preset_unknown() }}</p>
    </fieldset>
    <div tw-class="flex flex-wrap items-center gap-3 text-sm" v-if="!remote" data-testid="image-model-retention">
      <label tw-class="min-h-10 cursor-pointer inline-flex items-center gap-2">
        <input v-model="retainModel" type="checkbox" role="switch" :disabled="!supported" data-testid="image-retain-model" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />{{ lazyStrings.stableDiffusionCppBrowser__keep_model_loaded() }}</label>
      <span v-if="modelResident" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.stableDiffusionCppBrowser__model_resident() }}</span>
      <button type="button" :disabled="busy || !modelResident" @click="releaseModel" data-testid="image-release-model" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-bold text-gray-600 dark:text-gray-300 shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.stableDiffusionCppBrowser__release_model() }}</button>
    </div>

  </form>
</template>
