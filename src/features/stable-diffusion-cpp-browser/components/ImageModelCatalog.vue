<script setup lang="ts">
import { computed, reactive, useId } from 'vue';
import { BookOpenIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { imageModelRecipes, imageRecipeLink, selectedRecipeFiles, type ImageRecipeFile, type ImageRecipeSelection } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
const props = defineProps<{ disabled: boolean, view: ImageLibraryView }>();
const { downloading, importing, downloadProgress, downloadState, downloadRecipeId } = props.view;
const id = useId();
const choices = reactive<Record<string, ImageRecipeSelection>>({});
const cards = computed(() => imageModelRecipes.map(recipe => ({ recipe, files: selectedRecipeFiles({ recipe, selections: choices[recipe.id] ?? {} }) })));
function roleLabel({ role }: { role: ImageRecipeFile['role'] }): string | undefined {
  switch (role) {
  case 'diffusion': return lazyStrings.stableDiffusionCppBrowser__diffusion_file();
  case 'vae': return lazyStrings.stableDiffusionCppBrowser__vae_file();
  case 'lm': return lazyStrings.stableDiffusionCppBrowser__lm_file();
  default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
  }
}
function change({ recipeId, role, event }: { recipeId: string, role: ImageRecipeFile['role'], event: Event }): void {
  if (props.disabled || downloading.value || importing.value || !(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  const component = imageModelRecipes.find(recipe => recipe.id === recipeId)?.components.find(item => item.role === role);
  if (!component?.options.some(option => option.id === value)) return;
  choices[recipeId] = { ...choices[recipeId], [role]: value };
}
async function download({ recipeId }: { recipeId: string }): Promise<void> {
  if (!props.disabled) await props.view.downloadRecipe({ recipeId, selections: { ...choices[recipeId] } });
}
function select({ recipeId }: { recipeId: string }): void {
  if (!props.disabled) props.view.chooseRecipe({ recipeId, selections: { ...choices[recipeId] } });
}
const status = computed(() => {
  switch (downloadState.value) {
  case 'idle': return undefined;
  case 'downloading': return lazyStrings.stableDiffusionCppBrowser__downloading_selected();
  case 'complete': return lazyStrings.stableDiffusionCppBrowser__download_complete();
  case 'cancelled': return lazyStrings.stableDiffusionCppBrowser__download_cancelled();
  case 'failed': return lazyStrings.stableDiffusionCppBrowser__download_failed();
  default: { const exhaustive: never = downloadState.value; throw new Error(String(exhaustive)); }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { choices } }) || {}) });
</script>
<template>
  <details data-testid="image-model-catalog" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
    <summary tw-class="cursor-pointer font-semibold text-sm flex items-center gap-2"><BookOpenIcon tw-class="w-5 h-5 text-purple-600 dark:text-purple-400" />{{ lazyStrings.stableDiffusionCppBrowser__catalog_title() }} (2)</summary>
    <div tw-class="mt-4 space-y-4">
      <p tw-class="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">{{ lazyStrings.stableDiffusionCppBrowser__catalog_help() }}</p>
      <p tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__catalog_validation() }}</p>
      <article v-for="card in cards" :key="card.recipe.id" :data-testid="'image-recipe-' + card.recipe.id" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <h3 tw-class="text-sm font-semibold">{{ card.recipe.title }}</h3>
        <div v-for="(component, index) in card.recipe.components" :key="component.role" tw-class="space-y-1 border-t border-gray-100 dark:border-gray-800 pt-3">
          <label :for="id + card.recipe.id + component.role" tw-class="text-xs font-semibold">{{ roleLabel({ role: component.role }) }}</label>
          <select :id="id + card.recipe.id + component.role" :value="choices[card.recipe.id]?.[component.role] ?? component.defaultOptionId" :disabled="disabled || downloading || importing" @change="change({ recipeId: card.recipe.id, role: component.role, event: $event })" :data-testid="'recipe-option-' + card.recipe.id + '-' + component.role" tw-class="w-full block rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent p-2 text-xs">
            <option v-for="option in component.options" :key="option.id" :value="option.id">{{ option.path }} · {{ option.approximateSize }}</option>
          </select>
          <p tw-class="text-xs break-all text-gray-500 dark:text-gray-400">{{ card.files[index]?.repository }}</p>
          <a v-if="card.files[index]" :href="disabled ? undefined : imageRecipeLink({ file: card.files[index]!, action: 'source' })" :aria-disabled="disabled ? 'true' : undefined" :tabindex="disabled ? -1 : undefined" @click="disabled && $event.preventDefault()" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" tw-class="inline-flex gap-1 items-center text-xs underline text-purple-700 dark:text-purple-300"><ExternalLinkIcon tw-class="w-3 h-3" />{{ lazyStrings.stableDiffusionCppBrowser__catalog_source() }}</a>
        </div>
        <div tw-class="flex flex-wrap gap-3">
          <button type="button" :disabled="disabled || downloading || importing" @click="download({ recipeId: card.recipe.id })" :data-testid="'recipe-download-selected-' + card.recipe.id" tw-class="inline-flex gap-2 items-center rounded-lg px-3 py-2 text-xs font-semibold bg-purple-600 text-white disabled:opacity-40"><DownloadIcon tw-class="w-4 h-4" />{{ lazyStrings.stableDiffusionCppBrowser__download_and_select() }}</button>
          <button type="button" :disabled="disabled || downloading || importing" @click="select({ recipeId: card.recipe.id })" :data-testid="'recipe-use-local-' + card.recipe.id" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__select_saved_recipe() }}</button>
        </div>
        <div v-if="downloadRecipeId === card.recipe.id && status" role="status" tw-class="space-y-1 text-xs">
          <p>{{ status }}</p>
          <p v-if="downloadProgress" tw-class="break-all font-mono">{{ downloadProgress.phase }} · {{ downloadProgress.index + 1 }}/{{ downloadProgress.count }} · {{ downloadProgress.repository }}/{{ downloadProgress.path }}</p>
          <progress v-if="downloading && downloadProgress?.total" :value="downloadProgress.completed" :max="downloadProgress.total" tw-class="w-full" />
          <p v-if="downloading && downloadProgress?.total">{{ (downloadProgress.completed / 1024 ** 3).toFixed(2) }} / {{ (downloadProgress.total / 1024 ** 3).toFixed(2) }} GiB</p>
          <button v-if="downloading" type="button" :disabled="disabled" @click="view.cancelDownload()" data-testid="image-cancel-download" tw-class="underline text-red-600 dark:text-red-400">{{ lazyStrings.SHARED__cancel() }}</button>
        </div>
        <details tw-class="text-xs">
          <summary tw-class="cursor-pointer">{{ lazyStrings.stableDiffusionCppBrowser__catalog_layout() }}</summary>
          <pre tw-class="mt-2 whitespace-pre-wrap break-all">{{ card.files.map(file => 'models/huggingface.co/' + file.repository + '/resolve/main/' + file.path).join('\n') }}</pre>
        </details>
      </article>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__catalog_file_notice() }}</p>
    </div>
  </details>
</template>
