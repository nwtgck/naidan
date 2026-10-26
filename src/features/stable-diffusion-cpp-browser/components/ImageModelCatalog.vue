<script setup lang="ts">
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import { computed, reactive, ref, useId } from 'vue';
import { ChevronDownIcon, DownloadIcon, ExternalLinkIcon, LibraryBigIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { imageModelRecipes, imageRecipeLink, selectedRecipeFiles, type ImageRecipeFile, type ImageRecipeSelection } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import { imageCatalogLoras, type ImageCatalogLora } from '@/features/stable-diffusion-cpp-browser/lora-catalog';
import type { ImageDownloadQueueEntry, ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageCatalogDownloadStatus from './ImageCatalogDownloadStatus.vue';
import ImageHostModelDirectories from './ImageHostModelDirectories.vue';
import ImageModelLocalFileRecovery from './ImageModelLocalFileRecovery.vue';
const props = defineProps<{ disabled: boolean, downloadDisabled: boolean, view: ImageLibraryView }>();
const emit = defineEmits<{ selected: [] }>();
const { downloading, importing, downloadState, downloadRecipeId, downloadLoraId, scanState } = props.view;
const id = useId(), open = ref(true);
const catalogTrigger = ref<HTMLButtonElement>();
const choices = reactive<Record<string, ImageRecipeSelection>>({});
const detailsOpen = reactive<Record<string, boolean>>({});

function selection({ recipeId }: { recipeId: string }): ImageRecipeSelection {
  return choices[recipeId] ?? {};
}

const queuedDownloads = computed(() => props.view.downloadQueue.value.filter(job => job.state !== 'downloading'));

function queueStatus({ state }: { state: ImageDownloadQueueEntry['state'] }): string | undefined {
  switch (state) {
  case 'queued': return lazyStrings.ImageModelCatalog__queued();
  case 'downloading': return undefined;
  case 'paused': return lazyStrings.llamaCppBrowserDownloads__paused();
  case 'failed': return lazyStrings.stableDiffusionCppBrowser__download_failed();
  case 'incomplete': return lazyStrings.stableDiffusionCppBrowser__downloaded_but_incomplete();
  default: {
    const exhaustive: never = state;
    throw new Error(String(exhaustive));
  }
  }
}

const cards = computed(() => imageModelRecipes.map(recipe => {
  const selections = selection({ recipeId: recipe.id });
  const files = selectedRecipeFiles({ recipe, selections });
  const availability = props.view.recipeAvailability({ recipeId: recipe.id, selections });
  return { recipe, files, availability, selections, loras: imageCatalogLoras.filter(item => item.recipeId === recipe.id), bytes: files.reduce((sum, file) => sum + file.approximateBytes, 0) };
}));
const layoutFile = computed(() => imageCatalogLoras.find(item => item.id === downloadLoraId.value)?.source ?? cards.value.find(card => card.recipe.id === downloadRecipeId.value)?.files[0]);
// Detect storage without opening it. Host folders and manual model files have
// separate capabilities and must remain usable when OPFS is unavailable.
const opfsSupported = typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function' && typeof navigator.locks?.request === 'function';
const downloadDestinationUnavailable = computed(() => {
  const directories = props.view.hostDirectories;
  if (directories.busy.value) {
    return true;
  }
  if (directories.destination.value === 'opfs') {
    return !opfsSupported;
  }
  const entry = directories.entries.value.find(item => item.id === directories.destination.value);
  // An explicit download can request read/write permission for a known handle.
  return !directories.supported.value || !entry || ['missing', 'error', 'unsupported'].includes(entry.access);
});

function roleLabel({ role }: { role: ImageRecipeFile['role'] }): string | undefined {
  switch (role) {
  case 'model': return lazyStrings.stableDiffusionCppBrowser__model_file();
  case 'diffusion': return lazyStrings.stableDiffusionCppBrowser__diffusion_file();
  case 'vae': return lazyStrings.stableDiffusionCppBrowser__vae_file();
  case 'lm': return lazyStrings.stableDiffusionCppBrowser__lm_file();
  default: {
    const exhaustive: never = role;
    throw new Error(String(exhaustive));
  }
  }
}

function optionLabel({ file }: { file: ImageRecipeFile }): string {
  return /(?:[-_.])(Q\d[A-Z0-9_]*|BF16|FP16|F16)(?=\.|$)/i.exec(file.path)?.[1]?.toUpperCase() ?? 'safetensors';
}

function detailedOptionLabel({ file }: { file: ImageRecipeFile }): string | undefined {
  const size = lazyStrings.llamaCppBrowserDownloads__approximately_size({ size: formatDownloadBytes({ bytes: file.approximateBytes }) });
  return size === undefined ? undefined : `${optionLabel({ file })} · ${size}`;
}

function change({ recipeId, role, value }: { recipeId: string, role: ImageRecipeFile['role'], value: string }): void {
  if (props.downloadDisabled) {
    return;
  }
  const component = imageModelRecipes.find(recipe => recipe.id === recipeId)?.components.find(item => item.role === role);
  if (component?.options.some(option => option.id === value)) {
    const previous = { ...selection({ recipeId }) };
    choices[recipeId] = { ...previous, [role]: value };
  }
}

async function download({ recipeId }: { recipeId: string }): Promise<void> {
  if (!props.downloadDisabled && !importing.value && !downloadDestinationUnavailable.value) {
    await props.view.downloadRecipe({ recipeId, selections: { ...selection({ recipeId }) } });
  }
}

async function downloadLora({ id }: { id: string }): Promise<void> {
  if (!props.downloadDisabled && !importing.value && !downloadDestinationUnavailable.value) {
    await props.view.downloadLora({ id });
  }
}

function select({ recipeId }: { recipeId: string }): void {
  if (props.disabled || importing.value || scanState.value === 'scanning') {
    return;
  }
  props.view.chooseRecipe({ recipeId, selections: { ...selection({ recipeId }) } });
  if (props.view.ready.value) {
    emit('selected');
  }
}

function loraHelp({ usage }: { usage: ImageCatalogLora['usage'] }): string | undefined {
  switch (usage) {
  case 'style-reference': return lazyStrings.ImageModelCatalog__reference_style_lora_help();
  default: {
    const exhaustive: never = usage;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { choices } }) || {}) });
</script>
<template>
  <!-- Expansion is presentation only. Neither this default-open catalog nor
       option changes may fetch metadata, verify files, or instantiate a Worker. -->
  <section data-testid="image-model-catalog" tw-class="min-w-0 overflow-hidden rounded-xl border border-gray-200/70 bg-gray-50/40 dark:border-gray-800/80 dark:bg-gray-900/20">
    <SettingsSelectScope :active="open" :return-focus="catalogTrigger">
      <h3><button ref="catalogTrigger" type="button" :aria-expanded="open" :aria-controls="id + '-content'" data-testid="image-catalog-toggle" @click="open = !open" tw-class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-100/50 dark:hover:bg-gray-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 transition-colors"><span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><LibraryBigIcon aria-hidden="true" tw-class="h-4 w-4" /></span>{{ lazyStrings.stableDiffusionCppBrowser__catalog_title() }}<ChevronDownIcon :tw-class="['ml-auto w-4 h-4 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none', { 'rotate-180': open }]" /></button></h3>
      <div :id="id + '-content'" class="catalog-disclosure" :class="{ 'catalog-disclosure-open': open }" :inert="open ? undefined : true" :aria-hidden="!open">
        <div class="catalog-disclosure-inner">
          <div tw-class="px-4 pb-2">
            <ImageHostModelDirectories :view="view.hostDirectories" :opfs-supported="opfsSupported" :disabled="downloadDisabled || importing" :mutation-disabled="disabled" :downloading="downloading" :layout-file="layoutFile" />
            <div v-if="queuedDownloads.length" data-testid="image-download-queue" tw-class="border-t border-gray-100 dark:border-gray-800 py-3 space-y-2">
              <h4 tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200">{{ lazyStrings.ImageModelCatalog__download_queue() }}</h4>
              <ul tw-class="space-y-1.5">
                <li v-for="job in queuedDownloads" :key="job.id" :data-testid="'image-download-queue-' + job.id" tw-class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-white dark:bg-gray-800 px-2.5 py-2 text-xs">
                  <span tw-class="min-w-0 flex-1 break-words text-gray-700 dark:text-gray-200">{{ job.label }} · {{ job.destination }}</span>
                  <span tw-class="text-gray-500 dark:text-gray-400">{{ queueStatus({ state: job.state }) }}</span>
                  <button v-if="job.state === 'paused'" type="button" :disabled="downloadDisabled || importing" :data-testid="'image-download-queue-resume-' + job.id" @click="view.resumeDownload()" tw-class="rounded-md px-2 py-1 font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50">{{ lazyStrings.llamaCppBrowserDownloads__resume() }}</button>
                  <button v-if="job.state === 'failed' || job.state === 'incomplete'" type="button" :disabled="downloadDisabled || importing" :data-testid="'image-download-queue-retry-' + job.id" @click="view.retryQueuedDownload({ id: job.id })" tw-class="rounded-md px-2 py-1 font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50">{{ lazyStrings.llamaCppBrowserDownloads__retry() }}</button>
                  <button type="button" :disabled="downloadDisabled" :data-testid="'image-download-queue-remove-' + job.id" @click="view.removeQueuedDownload({ id: job.id })" tw-class="rounded-md px-2 py-1 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50">{{ lazyStrings.stableDiffusionCppBrowser__remove() }}</button>
                  <p v-if="job.error" tw-class="w-full break-words text-amber-700 dark:text-amber-400">{{ job.error }}</p>
                  <HuggingFaceDownloadFailureHint v-if="job.state === 'failed'" tw-class="w-full">
                    <ImageModelLocalFileRecovery :view="view" :disabled="disabled" />
                  </HuggingFaceDownloadFailureHint>
                  <CspMessageHint v-else-if="job.state === 'paused'" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" />
                </li>
              </ul>
            </div>
            <article v-for="card in cards" :key="card.recipe.id" :data-testid="'image-recipe-' + card.recipe.id" tw-class="min-w-0 border-t border-gray-100 dark:border-gray-800 py-3">
              <!-- Wrapping follows the available card width, NOT the viewport.
                 A desktop sidebar must not compress the model name into a sliver. -->
              <div tw-class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" data-testid="image-recipe-heading">
                <div tw-class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1" data-testid="image-recipe-title">
                  <h4 :id="id + card.recipe.id" tw-class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ card.recipe.title }}</h4>
                  <span v-if="card.recipe.recommendation === 'maintainer-tested'" :data-testid="'recipe-recommended-' + card.recipe.id" tw-class="shrink-0 rounded-full border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-300">{{ lazyStrings.ImageModelCatalog__recommended() }}</span>
                  <div tw-class="relative flex max-w-full items-center">
                    <SettingsFormSelect :aria-labelledby="id + card.recipe.id" :aria-label="roleLabel({ role: card.recipe.components[0]!.role })" :model-value="card.selections[card.recipe.components[0]!.role] ?? card.recipe.components[0]!.defaultOptionId" :disabled="downloadDisabled || card.recipe.components[0]!.options.length === 1" @update:model-value="change({ recipeId: card.recipe.id, role: card.recipe.components[0]!.role, value: $event })" :data-testid="'recipe-option-' + card.recipe.id + '-' + card.recipe.components[0]!.role" presentation="inline" :options="card.recipe.components[0]!.options.map(file => ({ value: file.id, label: optionLabel({ file }) }))" :label="roleLabel({ role: card.recipe.components[0]!.role })" />
                  </div>
                </div>
                <button v-if="card.availability.available === card.availability.total" type="button" :disabled="disabled || importing || scanState === 'scanning' || card.availability.selected" @click="select({ recipeId: card.recipe.id })" :data-testid="'recipe-use-local-' + card.recipe.id" tw-class="ml-auto group inline-flex min-h-9 max-w-full items-center justify-center gap-2 rounded-lg border border-gray-200/90 bg-white/80 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300/70 hover:bg-blue-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/80 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-blue-500/40 dark:hover:bg-gray-800">{{ card.availability.selected ? lazyStrings.stableDiffusionCppBrowser__selected() : lazyStrings.llamaCppBrowserDownloads__use_this_model() }}</button>
                <button v-else type="button" :disabled="downloadDisabled || importing || downloadDestinationUnavailable" @click="download({ recipeId: card.recipe.id })" :data-testid="'recipe-download-selected-' + card.recipe.id" tw-class="ml-auto group inline-flex min-h-9 max-w-full items-center justify-center gap-2 rounded-lg border border-gray-200/90 bg-white/80 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300/70 hover:bg-blue-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/80 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-blue-500/40 dark:hover:bg-gray-800"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.llamaCppBrowserDownloads__download() }}</button>
              </div>
              <p v-if="scanState === 'scanning'" role="status" data-testid="image-catalog-scan-status" tw-class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageModelCatalog__checking_saved_models() }}</p>
              <div data-testid="image-recipe-metadata" tw-class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                <span tw-class="tabular-nums">{{ card.availability.available === card.availability.total ? formatDownloadBytes({ bytes: card.availability.bytes }) : lazyStrings.llamaCppBrowserDownloads__approximately_size({ size: formatDownloadBytes({ bytes: card.bytes }) }) }} · {{ lazyStrings.stableDiffusionCppBrowser__file_count({ count: card.files.length }) }}</span>
                <span v-if="card.availability.available > 0 && card.availability.available < card.availability.total">{{ lazyStrings.stableDiffusionCppBrowser__files_available({ available: card.availability.available, total: card.availability.total }) }}</span>
                <button type="button" :aria-expanded="!!detailsOpen[card.recipe.id]" :aria-controls="id + card.recipe.id + '-details'" :data-testid="'recipe-details-toggle-' + card.recipe.id" @click="detailsOpen[card.recipe.id] = !detailsOpen[card.recipe.id]" tw-class="inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.llamaCppBrowserDownloads__details() }}<ChevronDownIcon :tw-class="['w-3 h-3 transition-transform motion-reduce:transition-none', { 'rotate-180': detailsOpen[card.recipe.id] }]" /></button>
              </div>
              <!-- Keep full-width guidance outside the inline metadata and Details toolbar. -->
              <CspMessageHint v-if="(card.availability.available !== card.availability.total || card.loras.some(lora => !view.loraAvailable({ id: lora.id }))) && !(downloadState === 'failed' && (downloadRecipeId === card.recipe.id || card.loras.some(lora => downloadLoraId === lora.id)))" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" />
              <ImageCatalogDownloadStatus v-if="downloadRecipeId === card.recipe.id && downloadState !== 'idle'" :view="view" :disabled="downloadDisabled || importing" :local-input-disabled="disabled" />
              <div :id="id + card.recipe.id + '-details'" class="catalog-disclosure" :class="{ 'catalog-disclosure-open': detailsOpen[card.recipe.id] }" :inert="detailsOpen[card.recipe.id] ? undefined : true" :aria-hidden="!detailsOpen[card.recipe.id]" data-testid="image-recipe-details">
                <SettingsSelectScope :active="!!detailsOpen[card.recipe.id]" :return-focus="undefined">
                  <div class="catalog-disclosure-inner">
                    <div tw-class="pt-3 space-y-3">
                      <div v-for="(component, index) in card.recipe.components" :key="component.role" tw-class="min-w-0 space-y-1.5 border-t border-gray-100 dark:border-gray-800 pt-2.5">
                        <div tw-class="flex flex-wrap items-center justify-between gap-2">
                          <label :for="id + card.recipe.id + component.role" tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ roleLabel({ role: component.role }) }}</label>
                          <SettingsFormSelect :id="id + card.recipe.id + component.role" :model-value="card.selections[component.role] ?? component.defaultOptionId" :disabled="downloadDisabled || component.options.length === 1" @update:model-value="change({ recipeId: card.recipe.id, role: component.role, value: $event })" :data-testid="'recipe-detail-option-' + card.recipe.id + '-' + component.role" :options="component.options.map(file => ({ value: file.id, label: detailedOptionLabel({ file }) }))" :label="roleLabel({ role: component.role })" />
                        </div>
                        <a :href="downloadDisabled ? undefined : 'https://huggingface.co/' + card.files[index]!.repository" :aria-disabled="downloadDisabled ? 'true' : undefined" :tabindex="downloadDisabled ? -1 : undefined" @click="downloadDisabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" tw-class="flex w-fit max-w-full items-start gap-1.5 rounded-sm text-xs text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><span tw-class="min-w-0 break-all">Hugging Face · {{ card.files[index]!.repository }}</span><ExternalLinkIcon tw-class="mt-0.5 w-3 h-3 shrink-0" /></a>
                        <div tw-class="flex min-w-0 items-start gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                          <a :href="downloadDisabled ? undefined : imageRecipeLink({ file: card.files[index]!, action: 'source' })" :aria-disabled="downloadDisabled ? 'true' : undefined" :tabindex="downloadDisabled ? -1 : undefined" @click="downloadDisabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-testid="image-catalog-source" tw-class="min-w-0 flex-1 flex items-start gap-1.5 font-mono leading-relaxed hover:underline"><span tw-class="min-w-0 break-all">{{ card.files[index]!.path }}</span><ExternalLinkIcon aria-hidden="true" tw-class="mt-0.5 w-3 h-3 shrink-0" /></a>
                          <a :href="downloadDisabled ? undefined : imageRecipeLink({ file: card.files[index]!, action: 'download' })" :aria-disabled="downloadDisabled ? 'true' : undefined" :tabindex="downloadDisabled ? -1 : undefined" @click="downloadDisabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" download :aria-label="lazyStrings.llamaCppBrowserDownloads__save_file_to_device()" :title="lazyStrings.llamaCppBrowserDownloads__save_file_to_device()" tw-class="shrink-0 rounded-lg p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><DownloadIcon tw-class="w-3.5 h-3.5" /></a>
                        </div>
                      </div>
                      <p tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__catalog_file_notice() }}</p>
                    </div>
                  </div>
                </SettingsSelectScope>
              </div>
              <div v-for="lora in card.loras" :key="lora.id" :data-testid="'catalog-lora-' + lora.id" tw-class="mt-3 space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
                <h5 tw-class="text-xs font-semibold">{{ lazyStrings.ImageModelCatalog__optional_lora() }}</h5>
                <a :href="downloadDisabled ? undefined : imageRecipeLink({ file: lora.source, action: 'source' })" :aria-disabled="downloadDisabled ? 'true' : undefined" :tabindex="downloadDisabled ? -1 : undefined" @click="downloadDisabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-testid="image-catalog-lora-source" tw-class="flex w-fit max-w-full items-start gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline"><span tw-class="min-w-0 break-all">{{ lora.title }} · {{ lora.source.repository }}</span><ExternalLinkIcon aria-hidden="true" tw-class="mt-0.5 w-3 h-3 shrink-0" /></a>
                <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ loraHelp({ usage: lora.usage }) }}</p>
                <div tw-class="flex flex-wrap items-center gap-2 text-xs">
                  <span>{{ formatDownloadBytes({ bytes: lora.source.size }) }}</span>
                  <span v-if="view.loraAvailable({ id: lora.id })" :data-testid="'catalog-lora-saved-' + lora.id">{{ lazyStrings.ImageModelCatalog__saved_choose_in_lora_controls() }}</span>
                  <button v-else type="button" :disabled="downloadDisabled || importing || downloadDestinationUnavailable" @click="downloadLora({ id: lora.id })" :data-testid="'catalog-lora-download-' + lora.id" tw-class="group inline-flex min-h-9 max-w-full items-center justify-center gap-2 rounded-lg border border-gray-200/90 bg-white/80 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300/70 hover:bg-blue-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/80 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-blue-500/40 dark:hover:bg-gray-800">{{ lazyStrings.llamaCppBrowserDownloads__download() }}</button>
                </div>
                <ImageCatalogDownloadStatus v-if="downloadLoraId === lora.id && downloadState !== 'idle'" :view="view" :disabled="downloadDisabled || importing" :local-input-disabled="disabled" />
              </div>
            </article>
          </div>
        </div>
      </div>
    </SettingsSelectScope>
  </section>
</template>
<style scoped>
.catalog-disclosure {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 220ms ease, opacity 180ms ease;
}
.catalog-disclosure-open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.catalog-disclosure-inner {
  min-height: 0;
  overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .catalog-disclosure {
    transition: none;
  }
}
</style>
