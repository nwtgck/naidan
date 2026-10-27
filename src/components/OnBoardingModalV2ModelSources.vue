<script setup lang="ts">
import { computed, ref, useId, useTemplateRef } from 'vue';
import { ChevronDownIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-vue-next';
import SettingsCollapse from './SettingsCollapse.vue';
import LlamaCppBrowserModelParameterFilter from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelParameterFilter.vue';
import { createSearchParameterFilter } from '@/features/llama-cpp-browser/hugging-face/parameter-filter';
import { lazyStrings } from '@/strings';

// These ordinary links open an external page only after a click.
// Preparing the guide never queries HF or starts a model download.
const expanded = ref(false);
const panelId = useId();
const trigger = useTemplateRef<HTMLButtonElement>('trigger');
const minimumBillions = ref('');
const maximumBillions = ref('');

const huggingFaceSearch = computed(() => {
  try {
    const filter = createSearchParameterFilter({ minimumBillions: minimumBillions.value, maximumBillions: maximumBillions.value });
    const url = new URL('https://huggingface.co/models');
    url.searchParams.set('apps', 'llama.cpp');
    if (filter !== undefined) {
      url.searchParams.set('num_parameters', filter);
    }
    // Derive the caption from the same normalized bounds used in the URL.
    const minimum = filter?.match(/(?:^|,)min:(\d+(?:\.\d+)?)B(?:,|$)/u)?.[1];
    const maximum = filter?.match(/(?:^|,)max:(\d+(?:\.\d+)?)B(?:,|$)/u)?.[1];
    return { href: url.href, minimum, maximum };
  } catch {
    return undefined;
  }
});
const huggingFaceModelsUrl = computed(() => huggingFaceSearch.value?.href);
const huggingFaceLinkCaption = computed(() => {
  const minimum = huggingFaceSearch.value?.minimum;
  const maximum = huggingFaceSearch.value?.maximum;
  if (maximum !== undefined) {
    if (minimum === undefined || minimum === '0') {
      return lazyStrings.OnBoardingModalV2ModelSources__find_models_with_up_to_billion_parameters_on_hugging_face({ count: maximum });
    }
    return lazyStrings.OnBoardingModalV2ModelSources__find_models_with_a_parameter_range_on_hugging_face({ minimum, maximum });
  }
  if (minimum !== undefined && minimum !== '0') {
    return lazyStrings.OnBoardingModalV2ModelSources__find_models_with_at_least_billion_parameters_on_hugging_face({ count: minimum });
  }
  return lazyStrings.OnBoardingModalV2ModelSources__find_models_on_hugging_face();
});
const invalidParameterRange = computed(() => huggingFaceSearch.value === undefined);
const naidanLinks = ['https://naidan.pages.dev', 'https://naidan-curated.pages.dev']
  .filter(href => new URL(href).origin !== window.location.origin);

function toggle(): void {
  expanded.value = !expanded.value;
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (expanded.value && event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    event.stopPropagation();
    expanded.value = false;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="onboarding-model-sources" tw-class="border-t border-gray-100 pt-2 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-300" @keydown="keydown({ event: $event })">
    <button ref="trigger" type="button" data-testid="onboarding-model-sources-trigger" :aria-expanded="expanded" :aria-controls="panelId" tw-class="group -mx-1 flex min-h-9 w-[calc(100%+0.5rem)] items-center justify-between gap-3 rounded-lg px-1 text-left font-medium text-gray-700 transition-colors duration-150 hover:bg-gray-100/70 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-200 dark:hover:bg-gray-800/60 dark:hover:text-gray-100 motion-reduce:transition-none" @click="toggle">
      <span tw-class="flex min-w-0 items-center gap-2"><DownloadIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 transition-colors duration-150 group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400 motion-reduce:transition-none" /><span tw-class="min-w-0">{{ lazyStrings.OnBoardingModalV2ModelSources__download_a_model() }}</span></span>
      <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none', expanded ? 'rotate-180' : '']" />
    </button>
    <SettingsCollapse :id="panelId" :open="expanded" :return-focus="trigger ?? undefined">
      <div tw-class="divide-y divide-gray-100 pb-1 pl-6 dark:divide-gray-800">
        <section tw-class="space-y-3 py-4">
          <h3 tw-class="font-medium leading-6 text-gray-900 dark:text-gray-100">{{ lazyStrings.OnBoardingModalV2ModelSources__download_from_hugging_face() }}</h3>
          <p tw-class="leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.OnBoardingModalV2ModelSources__load_the_downloaded_gguf_files_here() }}</p>
          <LlamaCppBrowserModelParameterFilter v-model:minimum-billions="minimumBillions" v-model:maximum-billions="maximumBillions" :disabled="false" :invalid="invalidParameterRange" :error-described-by="invalidParameterRange ? `${panelId}-parameter-error` : undefined" />
          <p v-if="invalidParameterRange" :id="`${panelId}-parameter-error`" role="alert" data-testid="onboarding-parameter-range-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.OnBoardingModalV2ModelSources__enter_a_valid_parameter_range() }}</p>
          <a :href="huggingFaceModelsUrl" role="link" :aria-disabled="invalidParameterRange" target="_blank" rel="noopener noreferrer" data-testid="onboarding-hugging-face-model-link" :tw-class="['inline-flex min-h-8 max-w-full items-center gap-1 rounded underline-offset-4 focus-visible:outline-2 focus-visible:outline-blue-500', invalidParameterRange ? 'cursor-not-allowed text-gray-400 dark:text-gray-600' : 'text-blue-600 hover:underline dark:text-blue-400']"><span tw-class="min-w-0 break-words">{{ huggingFaceLinkCaption }}</span><ExternalLinkIcon aria-hidden="true" tw-class="h-3 w-3 shrink-0 opacity-70" /></a>
        </section>
        <section v-if="naidanLinks.length > 0" tw-class="space-y-3 py-4">
          <h3 tw-class="font-medium leading-6 text-gray-900 dark:text-gray-100">{{ lazyStrings.OnBoardingModalV2ModelSources__download_and_use_in_naidan() }}</h3>
          <p tw-class="leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.OnBoardingModalV2ModelSources__download_and_run_models_in_these_naidan_sites() }}</p>
          <ul tw-class="list-disc space-y-1 pl-4">
            <li v-for="href in naidanLinks" :key="href" tw-class="min-w-0 pl-0.5 marker:text-gray-300 dark:marker:text-gray-600"><a :href="href" target="_blank" rel="noopener noreferrer" data-testid="onboarding-naidan-model-link" tw-class="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded text-blue-600 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-400"><span tw-class="min-w-0 break-all">{{ href }}</span><ExternalLinkIcon aria-hidden="true" tw-class="h-3 w-3 shrink-0 opacity-70" /></a></li>
          </ul>
        </section>
      </div>
    </SettingsCollapse>
  </div>
</template>
