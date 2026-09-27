<script setup lang="ts">
import { computed, reactive, ref, useId } from 'vue';
import { ChevronDownIcon, DownloadIcon, ExternalLinkIcon, LibraryBigIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { imageModelRecipes, imageRecipeLink, selectedRecipeFiles, type ImageRecipeFile, type ImageRecipeSelection } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import { imageCatalogLoras, type ImageCatalogLora } from '@/features/stable-diffusion-cpp-browser/lora-catalog';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageCatalogDownloadStatus from './ImageCatalogDownloadStatus.vue';
import ImageHostModelDirectories from './ImageHostModelDirectories.vue';
const props = defineProps<{ disabled: boolean, view: ImageLibraryView }>();
const emit = defineEmits<{ selected: [] }>();
const { downloading, importing, downloadState, downloadRecipeId, downloadLoraId, downloadSelections, scanState } = props.view;
const id = useId(), open = ref(true);
const choices = reactive<Record<string, ImageRecipeSelection>>({});
const detailsOpen = reactive<Record<string, boolean>>({});
function selection({ recipeId }: { recipeId: string }): ImageRecipeSelection {
  return downloadRecipeId.value === recipeId && (downloading.value || downloadState.value === 'paused' || downloadState.value === 'failed')
    ? downloadSelections.value : choices[recipeId] ?? {};
}
const cards = computed(() => imageModelRecipes.map(recipe => {
  const selections = selection({ recipeId: recipe.id });
  const files = selectedRecipeFiles({ recipe, selections });
  const availability = props.view.recipeAvailability({ recipeId: recipe.id, selections });
  return { recipe, files, availability, selections, loras: imageCatalogLoras.filter(item => item.recipeId === recipe.id), bytes: files.reduce((sum, file) => sum + file.approximateBytes, 0) };
}));
const layoutFile = computed(() => imageCatalogLoras.find(item => item.id === downloadLoraId.value)?.source ?? cards.value.find(card => card.recipe.id === downloadRecipeId.value)?.files[0]);
const downloadDestinationUnavailable = computed(() => {
  const directories = props.view.hostDirectories;
  if (directories.busy.value) return true;
  if (directories.destination.value === 'opfs') return false;
  const entry = directories.entries.value.find(item => item.id === directories.destination.value);
  // An explicit download can request read/write permission for a known handle.
  return !directories.supported.value || !entry || ['missing', 'error', 'unsupported'].includes(entry.access);
});
function locked({ recipeId: _recipeId }: { recipeId: string }): boolean {
  return props.disabled || downloading.value || importing.value;
}
function roleLabel({ role }: { role: ImageRecipeFile['role'] }): string | undefined {
  switch (role) {
  case 'model': return lazyStrings.stableDiffusionCppBrowser__model_file();
  case 'diffusion': return lazyStrings.stableDiffusionCppBrowser__diffusion_file();
  case 'vae': return lazyStrings.stableDiffusionCppBrowser__vae_file();
  case 'lm': return lazyStrings.stableDiffusionCppBrowser__lm_file();
  default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
  }
}
function optionLabel({ file }: { file: ImageRecipeFile }): string {
  return /(?:[-_.])(Q\d[A-Z0-9_]*|BF16|FP16|F16)(?=\.|$)/i.exec(file.path)?.[1]?.toUpperCase() ?? 'safetensors';
}
function change({ recipeId, role, event }: { recipeId: string, role: ImageRecipeFile['role'], event: Event }): void {
  if (locked({ recipeId }) || !(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  const component = imageModelRecipes.find(recipe => recipe.id === recipeId)?.components.find(item => item.role === role);
  if (component?.options.some(option => option.id === value)) {
    const previous = { ...selection({ recipeId }) };
    if (downloadRecipeId.value === recipeId) props.view.resetDownloadIntent();
    choices[recipeId] = { ...previous, [role]: value };
  }
}
async function download({ recipeId }: { recipeId: string }): Promise<void> {
  if (!props.disabled && !downloadDestinationUnavailable.value) await props.view.downloadRecipe({ recipeId, selections: { ...selection({ recipeId }) } });
}
async function downloadLora({ id }: { id: string }): Promise<void> {
  if (!props.disabled && !downloadDestinationUnavailable.value) await props.view.downloadLora({ id });
}
function select({ recipeId }: { recipeId: string }): void {
  if (props.disabled) return;
  props.view.chooseRecipe({ recipeId, selections: { ...selection({ recipeId }) } });
  if (props.view.ready.value) emit('selected');
}
function loraHelp({ usage }: { usage: ImageCatalogLora['usage'] }): string | undefined {
  switch (usage) {
  case 'style-reference': return lazyStrings.ImageModelCatalog__reference_style_lora_help();
  default: { const exhaustive: never = usage; throw new Error(String(exhaustive)); }
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { choices } }) || {}) });
</script>
<template>
  <!-- Expansion is presentation only. Neither this default-open catalog nor
       option changes may fetch metadata, verify files, or instantiate a Worker. -->
  <section data-testid="image-model-catalog" tw-class="min-w-0 rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 overflow-hidden">
    <h3><button type="button" :aria-expanded="open" :aria-controls="id + '-content'" data-testid="image-catalog-toggle" @click="open = !open" tw-class="flex w-full items-center gap-2 px-4 py-3.5 text-left text-sm font-bold text-gray-800 dark:text-white hover:bg-gray-100/50 dark:hover:bg-gray-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-500 transition-colors"><LibraryBigIcon tw-class="w-4 h-4 shrink-0 text-purple-500" />{{ lazyStrings.stableDiffusionCppBrowser__catalog_title() }}<ChevronDownIcon :tw-class="['ml-auto w-4 h-4 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none', { 'rotate-180': open }]" /></button></h3>
    <div :id="id + '-content'" class="catalog-disclosure" :class="{ 'catalog-disclosure-open': open }" :inert="open ? undefined : true" :aria-hidden="!open">
      <div class="catalog-disclosure-inner">
        <div tw-class="px-4 pb-2">
          <ImageHostModelDirectories :view="view.hostDirectories" :disabled="disabled || importing" :downloading="downloading" :layout-file="layoutFile" />
          <article v-for="card in cards" :key="card.recipe.id" :data-testid="'image-recipe-' + card.recipe.id" tw-class="min-w-0 border-t border-gray-100 dark:border-gray-800 py-3">
            <!-- Wrapping follows the available card width, NOT the viewport.
                 A desktop sidebar must not compress the model name into a sliver. -->
            <div tw-class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2" data-testid="image-recipe-heading">
              <div tw-class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1" data-testid="image-recipe-title">
                <h4 :id="id + card.recipe.id" tw-class="text-sm font-bold text-gray-800 dark:text-gray-100">{{ card.recipe.title }}</h4>
                <div tw-class="relative flex max-w-full items-center">
                  <select :aria-labelledby="id + card.recipe.id" :aria-label="roleLabel({ role: card.recipe.components[0]!.role })" :value="card.selections[card.recipe.components[0]!.role] ?? card.recipe.components[0]!.defaultOptionId" :disabled="locked({ recipeId: card.recipe.id }) || card.recipe.components[0]!.options.length === 1" @change="change({ recipeId: card.recipe.id, role: card.recipe.components[0]!.role, event: $event })" :data-testid="'recipe-option-' + card.recipe.id + '-' + card.recipe.components[0]!.role" tw-class="block h-6 max-w-full appearance-none rounded-md border border-transparent bg-transparent py-0 pl-1.5 pr-5 text-[11px] text-gray-500 dark:text-gray-400 enabled:hover:border-gray-200 dark:enabled:hover:border-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-60">
                    <option v-for="option in card.recipe.components[0]!.options" :key="option.id" :value="option.id" tw-class="bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-200">{{ optionLabel({ file: option }) }}</option>
                  </select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-1 w-2.5 h-2.5 text-gray-400" />
                </div>
              </div>
              <button v-if="card.availability.available === card.availability.total" type="button" :disabled="disabled || downloading || importing || card.availability.selected" @click="select({ recipeId: card.recipe.id })" :data-testid="'recipe-use-local-' + card.recipe.id" tw-class="ml-auto max-w-full rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 disabled:opacity-50">{{ card.availability.selected ? lazyStrings.stableDiffusionCppBrowser__selected() : lazyStrings.llamaCppBrowserDownloads__use_this_model() }}</button>
              <button v-else-if="downloadRecipeId !== card.recipe.id || !['downloading', 'paused', 'failed'].includes(downloadState)" type="button" :disabled="disabled || downloading || importing || scanState === 'scanning' || downloadDestinationUnavailable" @click="download({ recipeId: card.recipe.id })" :data-testid="'recipe-download-selected-' + card.recipe.id" tw-class="ml-auto inline-flex max-w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-50"><DownloadIcon tw-class="w-3.5 h-3.5 shrink-0" />{{ lazyStrings.llamaCppBrowserDownloads__download() }}</button>
            </div>
            <p v-if="scanState === 'scanning'" role="status" data-testid="image-catalog-scan-status" tw-class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageModelCatalog__checking_saved_models() }}</p>
            <div tw-class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
              <span tw-class="tabular-nums">{{ card.availability.available === card.availability.total ? formatDownloadBytes({ bytes: card.availability.bytes }) : lazyStrings.llamaCppBrowserDownloads__approximately_size({ size: formatDownloadBytes({ bytes: card.bytes }) }) }} · {{ lazyStrings.stableDiffusionCppBrowser__file_count({ count: card.files.length }) }}</span>
              <span v-if="card.availability.available > 0 && card.availability.available < card.availability.total">{{ lazyStrings.stableDiffusionCppBrowser__files_available({ available: card.availability.available, total: card.availability.total }) }}</span>
              <button type="button" :aria-expanded="!!detailsOpen[card.recipe.id]" :aria-controls="id + card.recipe.id + '-details'" :data-testid="'recipe-details-toggle-' + card.recipe.id" @click="detailsOpen[card.recipe.id] = !detailsOpen[card.recipe.id]" tw-class="inline-flex items-center gap-1 rounded-md px-1 py-1 text-xs hover:text-purple-600 dark:hover:text-purple-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500">{{ lazyStrings.llamaCppBrowserDownloads__details() }}<ChevronDownIcon :tw-class="['w-3 h-3 transition-transform motion-reduce:transition-none', { 'rotate-180': detailsOpen[card.recipe.id] }]" /></button>
            </div>
            <ImageCatalogDownloadStatus v-if="downloadRecipeId === card.recipe.id && downloadState !== 'idle'" :view="view" :disabled="disabled || importing" />
            <div :id="id + card.recipe.id + '-details'" class="catalog-disclosure" :class="{ 'catalog-disclosure-open': detailsOpen[card.recipe.id] }" :inert="detailsOpen[card.recipe.id] ? undefined : true" :aria-hidden="!detailsOpen[card.recipe.id]" data-testid="image-recipe-details">
              <div class="catalog-disclosure-inner">
                <div tw-class="pt-3 space-y-3">
                  <div v-for="(component, index) in card.recipe.components" :key="component.role" tw-class="min-w-0 space-y-1.5 border-t border-gray-100 dark:border-gray-800 pt-2.5">
                    <div tw-class="flex flex-wrap items-center justify-between gap-2">
                      <label :for="id + card.recipe.id + component.role" tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ roleLabel({ role: component.role }) }}</label>
                      <select :id="id + card.recipe.id + component.role" :value="card.selections[component.role] ?? component.defaultOptionId" :disabled="locked({ recipeId: card.recipe.id }) || component.options.length === 1" @change="change({ recipeId: card.recipe.id, role: component.role, event: $event })" :data-testid="'recipe-detail-option-' + card.recipe.id + '-' + component.role" tw-class="max-w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 disabled:opacity-60">
                        <option v-for="option in component.options" :key="option.id" :value="option.id">{{ optionLabel({ file: option }) }} · {{ lazyStrings.llamaCppBrowserDownloads__approximately_size({ size: formatDownloadBytes({ bytes: option.approximateBytes }) }) }}</option>
                      </select>
                    </div>
                    <a :href="disabled ? undefined : 'https://huggingface.co/' + card.files[index]!.repository" :aria-disabled="disabled ? 'true' : undefined" :tabindex="disabled ? -1 : undefined" @click="disabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" tw-class="flex w-fit max-w-full items-start gap-1.5 rounded-sm text-xs text-purple-600 dark:text-purple-400 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"><span tw-class="min-w-0 break-all">Hugging Face · {{ card.files[index]!.repository }}</span><ExternalLinkIcon tw-class="mt-0.5 w-3 h-3 shrink-0" /></a>
                    <div tw-class="flex min-w-0 items-start gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                      <a :href="disabled ? undefined : imageRecipeLink({ file: card.files[index]!, action: 'source' })" :aria-disabled="disabled ? 'true' : undefined" :tabindex="disabled ? -1 : undefined" @click="disabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" tw-class="min-w-0 flex-1 break-all font-mono leading-relaxed hover:underline">{{ card.files[index]!.path }}</a>
                      <a :href="disabled ? undefined : imageRecipeLink({ file: card.files[index]!, action: 'download' })" :aria-disabled="disabled ? 'true' : undefined" :tabindex="disabled ? -1 : undefined" @click="disabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" download :aria-label="lazyStrings.llamaCppBrowserDownloads__save_file_to_device()" :title="lazyStrings.llamaCppBrowserDownloads__save_file_to_device()" tw-class="shrink-0 rounded-lg p-1 text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"><DownloadIcon tw-class="w-3.5 h-3.5" /></a>
                    </div>
                  </div>
                  <p tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__catalog_file_notice() }}</p>
                </div>
              </div>
            </div>
            <div v-for="lora in card.loras" :key="lora.id" :data-testid="'catalog-lora-' + lora.id" tw-class="mt-3 space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
              <h5 tw-class="text-xs font-semibold">{{ lazyStrings.ImageModelCatalog__optional_lora() }}</h5>
              <a :href="disabled ? undefined : imageRecipeLink({ file: lora.source, action: 'source' })" :aria-disabled="disabled ? 'true' : undefined" :tabindex="disabled ? -1 : undefined" @click="disabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" tw-class="block break-all text-xs text-purple-600 dark:text-purple-400 hover:underline">{{ lora.title }} · {{ lora.source.repository }}</a>
              <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ loraHelp({ usage: lora.usage }) }}</p>
              <div tw-class="flex flex-wrap items-center gap-2 text-xs">
                <span>{{ formatDownloadBytes({ bytes: lora.source.size }) }}</span>
                <span v-if="view.loraAvailable({ id: lora.id })" :data-testid="'catalog-lora-saved-' + lora.id">{{ lazyStrings.ImageModelCatalog__saved_choose_in_lora_controls() }}</span>
                <button v-else-if="downloadLoraId !== lora.id || !['downloading', 'paused', 'failed'].includes(downloadState)" type="button" :disabled="disabled || downloading || importing || scanState === 'scanning' || downloadDestinationUnavailable" @click="downloadLora({ id: lora.id })" :data-testid="'catalog-lora-download-' + lora.id" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-purple-600 dark:text-purple-400 disabled:opacity-50">{{ lazyStrings.llamaCppBrowserDownloads__download() }}</button>
              </div>
              <ImageCatalogDownloadStatus v-if="downloadLoraId === lora.id && downloadState !== 'idle'" :view="view" :disabled="disabled || importing" />
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.catalog-disclosure { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 220ms ease, opacity 180ms ease; }
.catalog-disclosure-open { grid-template-rows: 1fr; opacity: 1; }
.catalog-disclosure-inner { min-height: 0; overflow: hidden; }
@media (prefers-reduced-motion: reduce) { .catalog-disclosure { transition: none; } }
</style>
