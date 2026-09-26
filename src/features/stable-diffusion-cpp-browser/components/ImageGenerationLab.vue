<script setup lang="ts">
import ImageModelLibrary from './ImageModelLibrary.vue';
import ImageRepositoryImport from './ImageRepositoryImport.vue';
import ImageModelCatalog from './ImageModelCatalog.vue';
import { computed, useId } from 'vue';
import { ImageIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { profileOptions, samplerOptions, schedulerOptions } from '@/features/stable-diffusion-cpp-browser/form-options';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation';

const id = useId();
const { debug, diagnosticText, diagnosticStatus, diagnosticFeedback, profile, layout, files, parameters, weightResidency, gpuBudgetMiB, progress, failure, invalid, cancelled, results,
  library, busy, supported, formDisabled, unavailable, chooseFile, resetFiles, removeResult, generate, cancel, copyDiagnostics, saveDiagnostics } = useImageGeneration();
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
  default: { const exhaustive: never = layout.value; throw new Error(String(exhaustive)); }
  }
});
const weightResidencyOptions = computed(() => [
  { value: 'auto' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_auto() },
  { value: 'cpu' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_cpu() },
  { value: 'hybrid' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_hybrid() },
  { value: 'disk' as const, label: lazyStrings.stableDiffusionCppBrowser__weight_residency_disk() },
]);

const phaseLabel = computed(() => {
  if (!progress.value) return undefined;
  switch (progress.value.phase) {
  case 'runtime': return lazyStrings.stableDiffusionCppBrowser__loading_runtime();
  case 'model': return lazyStrings.stableDiffusionCppBrowser__loading_model();
  case 'sampling': return lazyStrings.stableDiffusionCppBrowser__sampling();
  case 'decoding': return lazyStrings.stableDiffusionCppBrowser__decoding_image();
  case 'encoding': return lazyStrings.stableDiffusionCppBrowser__encoding();
  default: { const exhaustive: never = progress.value.phase; throw new Error(String(exhaustive)); }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { files, parameters, weightResidency, gpuBudgetMiB, results, generate } }) || {}) });
</script>

<template>
  <main tw-class="h-full overflow-y-auto bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" data-testid="image-generation-lab">
    <div tw-class="max-w-6xl mx-auto p-4 sm:p-8 space-y-6">
      <header tw-class="space-y-3">
        <h1 tw-class="text-2xl font-semibold flex items-center gap-3"><ImageIcon tw-class="w-7 h-7" />{{ lazyStrings.stableDiffusionCppBrowser__image_generation_lab() }}</h1>
        <p tw-class="text-sm text-gray-600 dark:text-gray-300">{{ lazyStrings.stableDiffusionCppBrowser__experimental_local_workspace() }}</p>
      </header>
      <p v-if="!supported" role="status" tw-class="rounded-xl border border-gray-300 dark:border-gray-700 p-4 text-sm" data-testid="image-unavailable">{{ unavailable }}</p>
      <section tw-class="space-y-3">
        <h2 tw-class="font-semibold text-base">{{ lazyStrings.stableDiffusionCppBrowser__add_models() }}</h2>
        <div tw-class="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,1fr)]">
          <ImageModelCatalog :disabled="formDisabled" :view="library" />
          <ImageRepositoryImport :disabled="formDisabled" :view="library" />
        </div>
      </section>
      <form @submit.prevent="generate" tw-class="space-y-5">
        <fieldset :disabled="formDisabled" tw-class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 space-y-4">
          <legend tw-class="text-base font-semibold px-2">{{ lazyStrings.stableDiffusionCppBrowser__selected_model() }}</legend>
          <ImageModelLibrary :view="library" :disabled="formDisabled" />
          <details tw-class="space-y-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
            <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.stableDiffusionCppBrowser__manual_model_files() }}</summary>
            <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__model_layout() }}</span>
              <select v-model="layout" @change="resetFiles" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2">
                <option value="checkpoint">{{ lazyStrings.stableDiffusionCppBrowser__checkpoint() }}</option>
                <option value="components">{{ lazyStrings.stableDiffusionCppBrowser__separate_components() }}</option>
              </select>
            </label>
            <div v-for="item in slots" :key="layout + item.slot" tw-class="space-y-1">
              <label :for="id + item.slot" tw-class="block text-sm">{{ item.label }}</label>
              <input :id="id + item.slot" :disabled="library.importing.value || library.downloading.value" type="file" accept=".gguf,.safetensors,.sft" @change="chooseFile({ slot: item.slot, event: $event })" tw-class="block w-full text-sm" :data-testid="'image-file-' + item.slot" />
            </div>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__companion_files_help() }}</p>
          </details>
        </fieldset>
        <fieldset :disabled="formDisabled" tw-class="space-y-4">
          <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__prompt() }}</span><textarea v-model="parameters.prompt" rows="4" maxlength="4096" required data-testid="image-prompt" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3" /></label>
          <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__negative_prompt() }}</span><textarea v-model="parameters.negativePrompt" rows="2" maxlength="4096" tw-class="block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3" /></label>
          <div tw-class="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__width() }}</span><input v-model.number="parameters.width" type="number" min="128" max="2048" step="64" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__height() }}</span><input v-model.number="parameters.height" type="number" min="128" max="2048" step="64" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__steps() }}</span><input v-model.number="parameters.steps" type="number" min="1" max="100" step="1" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__guidance() }}</span><input v-model.number="parameters.guidance" type="number" min="0" max="30" step="0.1" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
            <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__seed() }}</span><input v-model="parameters.seed" type="text" inputmode="numeric" maxlength="20" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
          </div>
          <details tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
            <summary tw-class="font-medium cursor-pointer">{{ lazyStrings.stableDiffusionCppBrowser__runtime_settings() }}</summary>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__advanced_parameters_help() }}</p>
            <div tw-class="grid sm:grid-cols-2 gap-4">
              <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__profile() }}</span>
                <select v-model="profile" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option v-for="value in profileOptions" :key="value" :value="value">{{ value }}</option></select>
              </label>
              <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__weight_residency() }}</span>
                <select v-model="weightResidency" data-testid="image-weight-residency" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option v-for="option in weightResidencyOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select>
              </label>
            </div>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__weight_residency_help() }}</p>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__memory_and_cancellation() }}</p>
            <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget() }}</span><input v-model.number="gpuBudgetMiB" data-testid="image-memory-budget" type="number" min="512" :max="profile === 'webgpu-wasm64-jspi' ? undefined : 4095" step="1" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
            <p data-testid="image-memory-budget-help" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget_help() }}</p>
            <div tw-class="grid sm:grid-cols-2 gap-4">
              <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__sampler() }}</span><select v-model="parameters.sampler" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option v-for="value in samplerOptions" :key="value" :value="value">{{ value }}</option></select></label>
              <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__scheduler() }}</span><select v-model="parameters.scheduler" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2"><option v-for="value in schedulerOptions" :key="value" :value="value">{{ value }}</option></select></label>
              <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__distilled_guidance() }}</span><input v-model.number="parameters.distilledGuidance" type="number" min="0" max="30" step="0.1" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
              <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__conditioning_cache() }}</span><input v-model.number="parameters.conditioningCacheSize" type="number" min="0" max="32" step="1" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
              <label tw-class="text-sm flex gap-2 items-center"><input v-model="parameters.vaeTiling" type="checkbox" />{{ lazyStrings.stableDiffusionCppBrowser__vae_tiling() }}</label>
              <label tw-class="text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__vae_tile_size() }}</span><input v-model.number="parameters.vaeTileSize" type="number" min="16" max="256" step="8" required tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
              <label tw-class="text-sm flex gap-2 items-center"><input v-model="parameters.flashAttention" type="checkbox" />{{ lazyStrings.stableDiffusionCppBrowser__flash_attention() }}</label>
            </div>
            <label tw-class="block text-sm space-y-1"><span>{{ lazyStrings.stableDiffusionCppBrowser__model_arguments() }}</span><input v-model="parameters.modelArguments" type="text" maxlength="4096" placeholder="qwen_image_2_1_prefix_cache=false" tw-class="block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" /></label>
          </details>
        </fieldset>
        <p v-if="invalid" role="alert" tw-class="text-red-600 dark:text-red-400 text-sm">{{ lazyStrings.stableDiffusionCppBrowser__check_inputs() }}</p>
        <div tw-class="flex flex-wrap items-center gap-3">
          <button type="submit" :disabled="busy || !supported || library.importing.value || library.downloading.value || (!!library.main.value && !library.ready.value)" data-testid="image-generate" tw-class="rounded-lg px-5 py-2.5 bg-purple-600 text-white hover:bg-purple-700 font-medium disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__generate() }}</button>
          <button type="button" :disabled="!busy" @click="cancel" data-testid="image-cancel" tw-class="rounded-xl px-5 py-2.5 border border-gray-200 dark:border-gray-700 disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__cancel() }}</button>
          <span v-if="busy" role="status" aria-live="polite" tw-class="text-sm">{{ phaseLabel }} <template v-if="progress && progress.steps > 0">{{ progress.step }} / {{ progress.steps }}</template></span>
        </div>
        <p v-if="cancelled" role="status" tw-class="text-sm">{{ lazyStrings.stableDiffusionCppBrowser__cancelled() }}</p>
      </form>
      <section tw-class="space-y-3">
        <h2 tw-class="text-lg font-semibold">{{ lazyStrings.stableDiffusionCppBrowser__generated_images() }}</h2>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__history_is_temporary() }}</p>
        <p v-if="!results.length" tw-class="py-12 text-center text-gray-500 border border-dashed border-gray-300 dark:border-gray-700 rounded-2xl">{{ lazyStrings.stableDiffusionCppBrowser__no_images_yet() }}</p>
        <div tw-class="grid sm:grid-cols-2 gap-5">
          <article data-testid="image-generated-result" v-for="result in results" :key="result.id" tw-class="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            <img :src="result.url" :alt="result.parameters.prompt" :width="result.parameters.width" :height="result.parameters.height" tw-class="w-full h-auto" />
            <div tw-class="p-4 space-y-2">
              <p tw-class="text-sm whitespace-pre-wrap break-words">{{ result.parameters.prompt }}</p>
              <p tw-class="text-xs text-gray-500">{{ result.modelVersion }} · {{ result.parameters.width }} × {{ result.parameters.height }} · {{ lazyStrings.stableDiffusionCppBrowser__seed() }}: {{ result.parameters.seed }}</p>
              <div tw-class="flex gap-4 text-sm"><a :href="result.url" :download="'naidan-image-' + result.parameters.seed + '.png'" tw-class="text-purple-600 dark:text-purple-400 underline">{{ lazyStrings.stableDiffusionCppBrowser__download_png() }}</a><button type="button" @click="removeResult({ resultId: result.id })" tw-class="text-gray-500 underline">{{ lazyStrings.stableDiffusionCppBrowser__remove() }}</button></div>
            </div>
          </article>
        </div>
      </section>
      <details tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-4 space-y-3" data-testid="image-live-diagnostics">
        <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.stableDiffusionCppBrowser__diagnostics() }}</summary>
        <div tw-class="flex flex-wrap items-center justify-between gap-3">
          <label tw-class="text-sm flex items-center gap-2"><input v-model="debug" type="checkbox" true-value="on" false-value="off" :disabled="formDisabled" data-testid="image-debug-mode" />{{ lazyStrings.stableDiffusionCppBrowser__debug_mode() }}</label>
        </div>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__debug_help() }}</p>
        <p v-if="diagnosticStatus" role="status" tw-class="text-xs font-mono break-words">{{ diagnosticStatus }}</p>
        <div tw-class="flex flex-wrap gap-3 text-sm">
          <button type="button" :disabled="!diagnosticText" @click="copyDiagnostics" data-testid="image-copy-diagnostics" tw-class="underline disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__copy_logs() }}</button>
          <button type="button" :disabled="!diagnosticText" @click="saveDiagnostics" data-testid="image-save-diagnostics" tw-class="underline disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__save_logs() }}</button>
          <span role="status" tw-class="text-xs">{{ diagnosticFeedback }}</span>
        </div>
        <details v-if="diagnosticText">
          <summary tw-class="text-xs cursor-pointer">{{ lazyStrings.stableDiffusionCppBrowser__show_logs() }}</summary>
          <pre tw-class="text-xs whitespace-pre-wrap break-all max-h-72 overflow-auto mt-2">{{ diagnosticText }}</pre>
        </details>
      </details>
      <details v-if="failure" open tw-class="rounded-xl border border-red-300 dark:border-red-800 p-4">
        <summary tw-class="font-medium">{{ lazyStrings.stableDiffusionCppBrowser__diagnostics() }}</summary><pre role="alert" tw-class="text-xs whitespace-pre-wrap break-words mt-3 max-h-72 overflow-auto">{{ failure }}</pre>
      </details>
    </div>
  </main>
</template>
