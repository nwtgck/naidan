<script setup lang="ts">
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ImageRecommendedFieldHint from './ImageRecommendedFieldHint.vue';
import { applyImageRecommendedField, type ImageRecommendedField } from '@/features/image-generation/recommended-fields';
import type { ImageGenerationRecommendation } from '@/features/stable-diffusion-cpp-browser/recommendations';
import { computed, ref, useId } from 'vue';
import { ArrowLeftRightIcon, DicesIcon, FileUpIcon, ImageIcon, SquareIcon, OctagonXIcon, ExternalLinkIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { profileOptions, samplerOptions, schedulerOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import ImageModelLibrary from '@/features/stable-diffusion-cpp-browser/components/ImageModelLibrary.vue';
import ImageModelConfiguration from '@/features/stable-diffusion-cpp-browser/components/ImageModelConfiguration.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageLoraControls from '@/features/stable-diffusion-cpp-browser/components/ImageLoraControls.vue';
import ImageInputControls from './ImageInputControls.vue';
import ImageInferenceLocation from './ImageInferenceLocation.vue';
import ImageRemoteModelConfiguration from './ImageRemoteModelConfiguration.vue';
import ImageModelPicker from '@/features/stable-diffusion-cpp-browser/components/ImageModelPicker.vue';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
const props = defineProps<{ view: ImageGenerationView, active: boolean, context?: string }>();
defineSlots<{ 'prompt-actions'({ field, text }: { field: 'prompt' | 'negativePrompt', text: string }): unknown }>();
const emit = defineEmits<{ manageModels: [] }>();
const id = useId();
const configurationOpen = ref(false);
const { seedMode, randomizeSeed, retainModel, modelResident, profile, layout, files, loras, imageInputs, parameters, weightResidency, gpuBudgetMiB, invalid, cancelled, stopping, progress, recommendation, manualInspectionState, library, busy, supported, formDisabled, draftDisabled, chooseFile, resetFiles, generate, cancel, forceCancel, releaseModel, applyRecommendedSettings } = props.view;
const inferenceRunning = computed(() => busy.value && progress.value !== undefined);
const remote = computed(() => props.view.inferenceLocation?.kind.value === 'naidan_rpc');
const hasModel = computed(() => remote.value ? !!props.view.inferenceLocation?.ready.value && !!props.view.inferenceLocation?.connected.value : !!library.selectedCandidateKey.value || !!files.value.model || !!files.value.diffusion);
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
  default: {
    const exhaustive: never = layout.value;
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
  if (draftDisabled.value) {
    return;
  }
  parameters.value.width = width;
  parameters.value.height = height;
}

const resolutionKey = computed(() => resolutions.some(size => size.width === parameters.value.width && size.height === parameters.value.height) ? `${parameters.value.width}x${parameters.value.height}` : 'custom');

function chooseResolution({ value }: { value: string }): void {
  const size = resolutions.find(size => `${size.width}x${size.height}` === value);
  if (size) {
    setResolution(size);
  }
}

function changeSeed({ event }: { event: Event }): void {
  if (draftDisabled.value || !(event.target instanceof HTMLInputElement)) {
    return;
  }
  parameters.value.seed = event.target.value;
  seedMode.value = 'fixed';
}

function swapResolution(): void {
  setResolution({ width: parameters.value.height, height: parameters.value.width });
}

const resolutionInvalid = computed(() => ![parameters.value.width, parameters.value.height].every(value => Number.isInteger(value) && value >= 128 && value <= 2048 && value % 64 === 0));
const componentSummary = computed(() => {
  const location = props.view.inferenceLocation;
  const components = remote.value && location ? location.components.value : library.components.value;
  return [location ? (remote.value ? location.label.value || 'Naidan RPC' : lazyStrings.ImageInferenceLocation__this_device()) : undefined,
    ...components.map(component => component.choices.find(choice => choice.candidateKey === component.selectedCandidateKey)?.label)].filter(Boolean).join(' · ');
});

function changeRetention({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  if (props.view.setRetainModel) {
    props.view.setRetainModel({ retain: event.target.checked });
  } else {
    retainModel.value = event.target.checked;
  }
}

function applyRecommendedField({ field, recommendationId, context }: { field: ImageRecommendedField, recommendationId: ImageGenerationRecommendation['id'], context: string | undefined }): void {
  const current = props.view.recommendation.value;
  if (props.view.draftDisabled.value || !current || current.id !== recommendationId || context !== props.context) {
    return;
  }
  parameters.value = applyImageRecommendedField({ parameters: parameters.value, recommendation: current, field });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <form @submit.prevent="generate({ submission: undefined })" tw-class="min-w-0 space-y-4">
    <SettingsSelectScope :active="active" :return-focus="undefined">
      <section :aria-label="lazyStrings.stableDiffusionCppBrowser__selected_model()" tw-class="space-y-3 rounded-2xl border border-gray-200/70 bg-white/70 p-4 dark:border-gray-800/80 dark:bg-gray-900/40" data-testid="image-model-setup">
        <ImageModelPicker v-if="remote && view.inferenceLocation" :active="active" :model-value="view.inferenceLocation.primaryKey.value" :choices="view.inferenceLocation.primaryChoices.value" :required="true" :label="lazyStrings.stableDiffusionCppBrowser__main_image_model()" :disabled="formDisabled || view.inferenceLocation.loading.value || !view.inferenceLocation.peerPublicKey.value" compact @update:model-value="view.inferenceLocation.choosePrimary({ id: $event })" data-testid="image-main-model" />
        <ImageModelLibrary v-else :active="active" :manual-name="(files.model || files.diffusion)?.name" :view="library" :disabled="formDisabled" @prepare="emit('manageModels')" />
        <ImageSettingsSection embedded v-model:open="configurationOpen" :title="lazyStrings.ImageGenerationEditor__model_configuration()" :summary="componentSummary" data-testid="image-component-settings">
          <ImageInferenceLocation v-if="view.inferenceLocation" :inference-location="view.inferenceLocation" :disabled="busy || view.historyActions.busy.value || !!view.draftRestoreDisabled?.value" />
          <ImageRemoteModelConfiguration v-if="remote && view.inferenceLocation" :inference-location="view.inferenceLocation" :disabled="formDisabled" :active="active" />
          <fieldset v-else :disabled="formDisabled" tw-class="min-w-0 space-y-4" data-testid="image-model-options">
            <ImageModelConfiguration :active="active" :view="library" :disabled="formDisabled" />
            <ImageLoraControls :active="active" embedded v-model="loras" :saved="library.savedLoras.value" :disabled="formDisabled || !supported || library.importing.value" />
            <ImageSettingsSection :title="lazyStrings.stableDiffusionCppBrowser__manual_model_files()" :summary="(files.model || files.diffusion)?.name" data-testid="image-manual-settings">
              <label tw-class="block text-sm space-y-1">
                <span>{{ lazyStrings.stableDiffusionCppBrowser__model_layout() }}</span>
                <SettingsFormSelect v-model="layout" @update:model-value="resetFiles" data-testid="image-layout" :options="[{ value: 'checkpoint', label: lazyStrings.stableDiffusionCppBrowser__checkpoint() }, { value: 'components', label: lazyStrings.stableDiffusionCppBrowser__separate_components() }]" :label="lazyStrings.stableDiffusionCppBrowser__model_layout()" :disabled="formDisabled || library.importing.value" />
              </label>
              <div v-for="item in slots" :key="layout + item.slot" tw-class="space-y-1">
                <label :for="id + item.slot" tw-class="block text-sm">{{ item.label }}</label>
                <label :tw-class="['inline-flex min-h-10 max-w-full items-center gap-2 rounded-xl border border-gray-200/80 bg-white/70 px-3 py-2 text-xs font-medium text-gray-600 transition-colors focus-within:ring-2 focus-within:ring-blue-500/30 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-300', formDisabled || library.importing.value ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:border-blue-200 hover:bg-blue-50/60 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10']"><FileUpIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><span tw-class="min-w-0 truncate">{{ files[item.slot]?.name || lazyStrings.ImageRepositoryImport__choose_files() }}</span><input :id="id + item.slot" :disabled="library.importing.value" type="file" accept=".gguf,.safetensors,.sft" @change="chooseFile({ slot: item.slot, event: $event })" tw-class="sr-only" :data-testid="'image-file-' + item.slot" /></label>
              </div>
              <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__companion_files_help() }}</p>

            </ImageSettingsSection>
          </fieldset>
        </ImageSettingsSection>
      </section>
      <section tw-class="space-y-2" data-testid="image-prompt-section">
        <div tw-class="rounded-xl border border-gray-200/80 bg-white dark:bg-gray-900/40 px-3.5 pb-1.5 pt-2 transition-colors hover:border-gray-300 focus-within:border-blue-400/70 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/70 dark:hover:border-gray-600 dark:focus-within:border-blue-500/60">
          <div tw-class="flex items-center justify-between gap-2"><label :for="id + '-prompt'" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.stableDiffusionCppBrowser__prompt() }}</label><div tw-class="flex items-center gap-1"><slot name="prompt-actions" :field="'prompt'" :text="parameters.prompt" /><ImageGenerationCopyButton :text="parameters.prompt" :label="lazyStrings.imageGeneration__copy_prompt()" data-testid="image-copy-draft-prompt" /></div></div>
          <textarea :id="id + '-prompt'" :placeholder="lazyStrings.stableDiffusionCppBrowser__prompt()" :disabled="draftDisabled" v-model="parameters.prompt" rows="4" maxlength="4096" required data-testid="image-prompt" tw-class="block w-full resize-y border-0 bg-transparent px-0.5 py-2 text-sm leading-7 text-gray-800 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-100" />
        </div>
        <div tw-class="rounded-xl border border-gray-200/80 bg-gray-50/70 dark:bg-gray-800/20 px-3.5 pb-1.5 pt-2 transition-colors hover:border-gray-300 focus-within:border-blue-400/70 focus-within:ring-2 focus-within:ring-blue-500/10 dark:border-gray-700/70 dark:hover:border-gray-600 dark:focus-within:border-blue-500/60">
          <div tw-class="flex items-center justify-between gap-2"><label :for="id + '-negative-prompt'" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.stableDiffusionCppBrowser__negative_prompt() }}</label><div tw-class="flex items-center gap-1"><slot name="prompt-actions" :field="'negativePrompt'" :text="parameters.negativePrompt" /><ImageGenerationCopyButton :text="parameters.negativePrompt" :label="lazyStrings.imageGeneration__copy_negative_prompt()" data-testid="image-copy-draft-negative-prompt" /></div></div>
          <textarea :id="id + '-negative-prompt'" :disabled="draftDisabled" :placeholder="lazyStrings.stableDiffusionCppBrowser__negative_prompt()" v-model="parameters.negativePrompt" rows="1" maxlength="4096" data-testid="image-negative-prompt" tw-class="block w-full resize-y border-0 bg-transparent px-0.5 py-2 text-sm leading-7 text-gray-800 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-100" />
        </div>
        <div tw-class="flex flex-wrap items-center gap-2" data-testid="image-generation-actions">
          <button type="submit" :disabled="formDisabled || !supported || !hasModel || (!remote && (library.importing.value || (!!library.selectedCandidateKey.value && !library.ready.value)))" data-testid="image-generate" tw-class="flex min-h-11 flex-1 items-center justify-center gap-2.5 rounded-xl border px-5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-100 dark:hover:border-blue-400/60 dark:hover:bg-gray-800"><ImageIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ lazyStrings.stableDiffusionCppBrowser__generate() }}</button>

          <button type="button" :disabled="!inferenceRunning || stopping" @click="cancel" data-testid="image-cancel" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">
            <SquareIcon aria-hidden="true" tw-class="h-4 w-4 fill-current" />{{ lazyStrings.stableDiffusionCppBrowser__cancel() }}</button>
          <button v-if="stopping" type="button" :disabled="!inferenceRunning" @click="forceCancel" data-testid="image-force-cancel" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-sm font-medium text-red-700 dark:text-red-300 hover:border-red-300 dark:hover:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-40 disabled:cursor-not-allowed">
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
            <label tw-class="w-full text-xs space-y-1">
              <span>{{ lazyStrings.ImageGenerationEditor__image_size() }}</span>
              <SettingsFormSelect :model-value="resolutionKey" @update:model-value="chooseResolution({ value: $event })" data-testid="image-resolution-presets" :options="[{ value: 'custom', label: lazyStrings.ImageGenerationEditor__custom_size() }, ...resolutions.map(size => ({ value: size.width + 'x' + size.height, label: size.width + ' × ' + size.height }))]" :label="lazyStrings.ImageGenerationEditor__image_size()" :disabled="draftDisabled" />
            </label>
            <div tw-class="min-w-28 flex-1 text-xs space-y-1">
              <div tw-class="flex flex-wrap items-center justify-between gap-1"><label :for="id + '-recommended-width'">{{ lazyStrings.stableDiffusionCppBrowser__width() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="width" :current="parameters.width" :input-id="id + '-recommended-width'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
              <input :id="id + '-recommended-width'" v-model.number="parameters.width" type="number" min="128" max="2048" step="64" required data-testid="image-width" tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 px-2.5 py-2 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 text-sm tabular-nums" />
            </div>
            <div tw-class="min-w-28 flex-1 text-xs space-y-1">
              <div tw-class="flex flex-wrap items-center justify-between gap-1"><label :for="id + '-recommended-height'">{{ lazyStrings.stableDiffusionCppBrowser__height() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="height" :current="parameters.height" :input-id="id + '-recommended-height'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
              <input :id="id + '-recommended-height'" v-model.number="parameters.height" type="number" min="128" max="2048" step="64" required data-testid="image-height" tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 px-2.5 py-2 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 text-sm tabular-nums" />
            </div>
            <button type="button" @click="swapResolution" data-testid="image-swap-resolution" :aria-label="lazyStrings.ImageGenerationEditor__swap_width_and_height()" :title="lazyStrings.ImageGenerationEditor__swap_width_and_height()" tw-class="inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><ArrowLeftRightIcon tw-class="w-4 h-4" /></button>
          </div>
          <p v-if="resolutionInvalid" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300" data-testid="image-resolution-warning">{{ lazyStrings.ImageGenerationEditor__resolution_must_use_supported_dimensions() }}</p>
        </section>
        <div tw-class="grid grid-cols-2 gap-3">
          <div tw-class="text-sm space-y-1"><div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-steps'">{{ lazyStrings.stableDiffusionCppBrowser__steps() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="steps" :current="parameters.steps" :input-id="id + '-recommended-steps'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div><input :id="id + '-recommended-steps'" v-model.number="parameters.steps" data-testid="image-steps" type="number" min="1" max="100" step="1" required tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35" /></div>
          <div tw-class="text-sm space-y-1"><div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-guidance'">{{ lazyStrings.stableDiffusionCppBrowser__guidance() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="guidance" :current="parameters.guidance" :input-id="id + '-recommended-guidance'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div><input :id="id + '-recommended-guidance'" v-model.number="parameters.guidance" data-testid="image-guidance" type="number" min="0" max="30" step="0.1" required tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35" /></div>
        </div>
        <div tw-class="space-y-1.5">
          <label :for="id + '-seed'" tw-class="text-sm">{{ lazyStrings.stableDiffusionCppBrowser__seed() }}</label>
          <div tw-class="flex items-stretch gap-2">
            <input :id="id + '-seed'" :value="seedMode === 'random' ? '' : parameters.seed" :readonly="seedMode === 'random'" @input="changeSeed({ event: $event })" :placeholder="seedMode === 'random' ? '—' : undefined" type="text" inputmode="numeric" maxlength="20" :required="seedMode === 'fixed'" data-testid="image-seed" tw-class="min-w-0 flex-1 rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 text-sm font-mono outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 read-only:bg-gray-50 dark:read-only:bg-gray-800/40" />
            <button type="button" @click="randomizeSeed" :aria-label="lazyStrings.ImageGenerationEditor__pick_new_seed()" data-testid="image-randomize-seed" tw-class="min-h-10 min-w-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><DicesIcon tw-class="w-4 h-4" /></button>
            <span tw-class="block w-[46%] max-w-48 shrink-0"><SettingsFormSelect v-model="seedMode" :aria-label="lazyStrings.stableDiffusionCppBrowser__seed()" data-testid="image-seed-mode" :options="[{ value: 'random', label: lazyStrings.ImageGenerationEditor__new_seed_each_time() }, { value: 'fixed', label: lazyStrings.ImageGenerationEditor__fixed_seed() }]" :label="lazyStrings.stableDiffusionCppBrowser__seed()" :disabled="draftDisabled" /></span>
          </div>
        </div>
      </fieldset>
      <fieldset :disabled="draftDisabled" tw-class="min-w-0 space-y-2">
        <ImageSettingsSection :title="lazyStrings.ImageGenerationEditor__sampling_settings()" :summary="parameters.sampler + ' · ' + parameters.scheduler" data-testid="image-sampling-settings">
          <div tw-class="grid sm:grid-cols-2 gap-3">
            <div tw-class="block text-sm space-y-1">
              <div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-sampler'">{{ lazyStrings.stableDiffusionCppBrowser__sampler() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="sampler" :current="parameters.sampler" :input-id="id + '-recommended-sampler'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
              <SettingsFormSelect :id="id + '-recommended-sampler'" v-model="parameters.sampler" data-testid="image-sampler" :options="samplerOptions.map(value => ({ value, label: value }))" :label="lazyStrings.stableDiffusionCppBrowser__sampler()" :disabled="draftDisabled" />
            </div>
            <div tw-class="block text-sm space-y-1">
              <div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-scheduler'">{{ lazyStrings.stableDiffusionCppBrowser__scheduler() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="scheduler" :current="parameters.scheduler" :input-id="id + '-recommended-scheduler'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
              <SettingsFormSelect :id="id + '-recommended-scheduler'" v-model="parameters.scheduler" data-testid="image-scheduler" :options="schedulerOptions.map(value => ({ value, label: value }))" :label="lazyStrings.stableDiffusionCppBrowser__scheduler()" :disabled="draftDisabled" />
            </div>
            <div tw-class="text-sm space-y-1">
              <div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-distilledGuidance'">{{ lazyStrings.stableDiffusionCppBrowser__distilled_guidance() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="distilledGuidance" :current="parameters.distilledGuidance" :input-id="id + '-recommended-distilledGuidance'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
              <input :id="id + '-recommended-distilledGuidance'" v-model.number="parameters.distilledGuidance" data-testid="image-distilled-guidance" type="number" min="0" max="30" step="0.1" required tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35" />
            </div>
          </div>
        </ImageSettingsSection>
      </fieldset>
      <fieldset v-if="!remote" :disabled="draftDisabled" tw-class="min-w-0 space-y-2">
        <ImageSettingsSection :title="lazyStrings.stableDiffusionCppBrowser__runtime_settings()" :summary="parameters.bf16WeightType.toUpperCase() + ' · ' + profile">
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__advanced_parameters_help() }}</p>
          <div tw-class="grid sm:grid-cols-2 gap-4">
            <label tw-class="block text-sm space-y-1">
              <span>{{ lazyStrings.stableDiffusionCppBrowser__profile() }}</span>
              <SettingsFormSelect v-model="profile" :options="profileOptions.map(value => ({ value, label: value }))" :label="lazyStrings.stableDiffusionCppBrowser__profile()" :disabled="draftDisabled" />
            </label>
            <label tw-class="block text-sm space-y-1">
              <span>{{ lazyStrings.stableDiffusionCppBrowser__weight_residency() }}</span>
              <SettingsFormSelect v-model="weightResidency" data-testid="image-weight-residency" :options="weightResidencyOptions" :label="lazyStrings.stableDiffusionCppBrowser__weight_residency()" :disabled="draftDisabled" />
            </label>
          </div>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__weight_residency_help() }}</p>
          <div tw-class="block text-sm space-y-1">
            <div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-bf16WeightType'">{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="bf16WeightType" :current="parameters.bf16WeightType" :input-id="id + '-recommended-bf16WeightType'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
            <SettingsFormSelect :id="id + '-recommended-bf16WeightType'" v-model="parameters.bf16WeightType" data-testid="image-bf16-weight-type" :options="[{ value: 'f32', label: 'F32' }, { value: 'f16', label: 'F16' }]" :label="lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion()" :disabled="draftDisabled" />
          </div>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion_help() }}</p>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__memory_and_cancellation() }}</p>
          <label tw-class="block text-sm space-y-1">
            <span>{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget() }}</span>
            <input v-model.number="gpuBudgetMiB" data-testid="image-memory-budget" type="number" min="512" :max="profile === 'webgpu-wasm64-jspi' ? undefined : 4095" step="1" tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35" />
          </label>
          <p data-testid="image-memory-budget-help" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget_help() }}</p>
          <div tw-class="grid sm:grid-cols-2 gap-4">
            <div tw-class="text-sm space-y-1">
              <div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-conditioningCacheSize'">{{ lazyStrings.stableDiffusionCppBrowser__conditioning_cache() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="conditioningCacheSize" :current="parameters.conditioningCacheSize" :input-id="id + '-recommended-conditioningCacheSize'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
              <input :id="id + '-recommended-conditioningCacheSize'" v-model.number="parameters.conditioningCacheSize" type="number" min="0" max="32" step="1" required tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35" />
            </div>
            <div tw-class="flex flex-wrap items-center justify-between gap-2"><label tw-class="min-h-10 cursor-pointer text-sm flex gap-2 items-center">
              <SettingsChoiceControl presentation="switch"><input :id="id + '-recommended-vaeTiling'" v-model="parameters.vaeTiling" type="checkbox" role="switch" /></SettingsChoiceControl>{{ lazyStrings.stableDiffusionCppBrowser__vae_tiling() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="vaeTiling" :current="parameters.vaeTiling" :input-id="id + '-recommended-vaeTiling'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
            <div tw-class="text-sm space-y-1">
              <div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-vaeTileSize'">{{ lazyStrings.stableDiffusionCppBrowser__vae_tile_size() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="vaeTileSize" :current="parameters.vaeTileSize" :input-id="id + '-recommended-vaeTileSize'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
              <input :id="id + '-recommended-vaeTileSize'" v-model.number="parameters.vaeTileSize" type="number" min="16" max="256" step="8" required tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35" />
            </div>
            <div tw-class="flex flex-wrap items-center justify-between gap-2"><label tw-class="min-h-10 cursor-pointer text-sm flex gap-2 items-center">
              <SettingsChoiceControl presentation="switch"><input :id="id + '-recommended-flashAttention'" v-model="parameters.flashAttention" type="checkbox" role="switch" /></SettingsChoiceControl>{{ lazyStrings.stableDiffusionCppBrowser__flash_attention() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="flashAttention" :current="parameters.flashAttention" :input-id="id + '-recommended-flashAttention'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
          </div>
          <div tw-class="flex flex-wrap items-center justify-between gap-2"><label tw-class="min-h-10 cursor-pointer text-sm flex gap-2 items-center">
            <SettingsChoiceControl presentation="switch"><input :id="id + '-recommended-qwenVaePolicy'" v-model="parameters.qwenVaePolicy" type="checkbox" role="switch" true-value="bounded" false-value="native" data-testid="image-qwen-vae-policy" /></SettingsChoiceControl>{{ lazyStrings.stableDiffusionCppBrowser__qwen_vae_bounded() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="qwenVaePolicy" :current="parameters.qwenVaePolicy" :input-id="id + '-recommended-qwenVaePolicy'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__qwen_vae_help() }}</p>
          <div tw-class="block text-sm space-y-1">
            <div tw-class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><label :for="id + '-recommended-modelArguments'">{{ lazyStrings.stableDiffusionCppBrowser__model_arguments() }}</label><ImageRecommendedFieldHint :recommendation="recommendation" field="modelArguments" :current="parameters.modelArguments" :input-id="id + '-recommended-modelArguments'" :context="context" :disabled="draftDisabled" :busy="busy" @apply="applyRecommendedField" /></div>
            <input :id="id + '-recommended-modelArguments'" v-model="parameters.modelArguments" type="text" maxlength="4096" placeholder="qwen_image_2_1_prefix_cache=false" tw-class="outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50 block w-full rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 p-2.5 text-gray-800 dark:text-gray-100  transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35" />
          </div>
        </ImageSettingsSection>
        <div v-if="!remote && recommendation" tw-class="flex flex-wrap items-start gap-2" data-testid="image-recommendation">
          <ImageSettingsSection :title="lazyStrings.stableDiffusionCppBrowser__recommended_settings()" :summary="recommendation.title" tw-class="basis-64 flex-1 min-w-0">
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__steps() }} {{ recommendation.parameters.steps }} · {{ lazyStrings.stableDiffusionCppBrowser__guidance() }} {{ recommendation.parameters.guidance }} · {{ recommendation.parameters.sampler }}</p>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__recommended_preview_summary() }} {{ recommendation.preview.mode === 'vae' ? lazyStrings.stableDiffusionCppBrowser__preview_vae() : lazyStrings.stableDiffusionCppBrowser__preview_projection() }} · {{ lazyStrings.stableDiffusionCppBrowser__preview_interval() }} {{ recommendation.preview.interval }} · {{ lazyStrings.stableDiffusionCppBrowser__preview_after_step() }} {{ recommendation.preview.startStep }}</p>
            <ImageSettingsSection embedded compact :title="lazyStrings.stableDiffusionCppBrowser__preset_sources()" :summary="undefined" data-testid="image-recommendation-sources">
              <p data-testid="image-recommendation-policy" tw-class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{{ lazyStrings.stableDiffusionCppBrowser__preset_policy() }}</p>
              <p v-if="recommendation.id === 'qwen-image-2.1'" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__qwen_preset_policy() }}</p>
              <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ recommendation.checkedAt }}</p>
              <a v-for="source in recommendation.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-testid="image-recommendation-source" tw-class="flex w-fit max-w-full items-start gap-1.5 rounded-sm text-xs text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><span tw-class="min-w-0 [overflow-wrap:anywhere]">{{ source.label }}</span><ExternalLinkIcon aria-hidden="true" tw-class="mt-0.5 w-3 h-3 shrink-0" /></a>
            </ImageSettingsSection>
          </ImageSettingsSection>
          <button type="button" @click="applyRecommendedSettings" :disabled="draftDisabled || library.importing.value" data-testid="image-apply-recommendation" tw-class="ml-auto shrink-0 min-h-12 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-medium text-blue-600 dark:text-blue-400 hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">{{ lazyStrings.stableDiffusionCppBrowser__apply_recommended_settings() }}</button>
        </div>
        <p v-else-if="!remote && manualInspectionState === 'scanning'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__scanning_repositories() }}</p>
        <p v-else-if="!remote && (library.selectedCandidateKey.value || files.model || files.diffusion)" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__preset_unknown() }}</p>
      </fieldset>
      <div tw-class="flex flex-wrap items-center gap-3 text-sm" v-if="!remote" data-testid="image-model-retention">
        <label tw-class="min-h-10 cursor-pointer inline-flex items-center gap-2">
          <SettingsChoiceControl presentation="switch"><input :checked="retainModel" @change="changeRetention({ event: $event })" type="checkbox" role="switch" :disabled="!supported" data-testid="image-retain-model" /></SettingsChoiceControl>{{ lazyStrings.stableDiffusionCppBrowser__keep_model_loaded() }}</label>
        <span v-if="modelResident" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.stableDiffusionCppBrowser__model_resident() }}</span>
        <button type="button" :disabled="busy || !modelResident" @click="releaseModel" data-testid="image-release-model" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.stableDiffusionCppBrowser__release_model() }}</button>
      </div>

    </SettingsSelectScope>
  </form>
</template>
