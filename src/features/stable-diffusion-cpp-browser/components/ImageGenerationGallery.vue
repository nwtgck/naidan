<script setup lang="ts">
import { computed, ref, defineAsyncComponent } from 'vue';
import { StarIcon, ChevronDownIcon, TagsIcon } from 'lucide-vue-next';
import { usePrompt } from '@/composables/usePrompt';
import { ensureStrings, lazyStrings } from '@/strings';
import { idToRaw, type ImageGenerationRunId, type ImageGenerationTagId } from '@/01-models/ids';
import type { ImageGenerationRunExecution } from '@/01-models/image-generation';
import type { ImageGenerationTile, ImageGenerationWorkspaceView } from '@/features/stable-diffusion-cpp-browser/composables/use-image-generation-workspace';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
import ImageGenerationAssetCard from './ImageGenerationAssetCard.vue';
import ImageGenerationCurationActions from './ImageGenerationCurationActions.vue';
const ImageGenerationCompare = defineAsyncComponent(() => import('./ImageGenerationCompare.vue'));
const props = defineProps<{ view: ImageGenerationWorkspaceView }>();
const view = props.view;
const { text, onlyFavorite, mode, selection } = view;
const tagsOpen = ref(false);
const { showPrompt } = usePrompt();
const runById = computed(() => new Map(view.runs.value.map(run => [run.id, run])));
const groupedRuns = computed(() => {
  const grouped = new Map(view.runs.value.map(run => [run.id, { run, images: [] as ImageGenerationTile[] }]));
  for (const tile of view.tiles.value) grouped.get(tile.runId)?.images.push(tile);
  return [...grouped.values()].sort((a, b) => b.run.createdAt - a.run.createdAt || String(a.run.id).localeCompare(String(b.run.id))).filter(group => group.images.length || !text.value && !onlyFavorite.value && !view.filterTagId.value && view.visibility.value !== 'archived' && !view.runsWithAssets.value.includes(group.run.id) && group.run.execution.type !== 'completed');
});
function statusLabel({ execution }: { execution: ImageGenerationRunExecution }): string | undefined {
  switch (execution.type) {
  case 'queued': return lazyStrings.imageGeneration__queued();
  case 'running': return lazyStrings.imageGeneration__running();
  case 'completed': return lazyStrings.imageGeneration__completed();
  case 'cancelled': return lazyStrings.imageGeneration__cancelled();
  case 'failed': return lazyStrings.imageGeneration__failed();
  case 'interrupted': return lazyStrings.imageGeneration__interrupted();
  default: { const exhaustive: never = execution; throw new Error(String(exhaustive)); }
  }
}
async function editTag({ tagId }: { tagId: ImageGenerationTagId | undefined }): Promise<void> {
  const storeId = view.store.value?.storeId;
  if (!storeId) return;
  const label = await showPrompt({ title: tagId ? await ensureStrings.imageGeneration__rename_tag() : await ensureStrings.imageGeneration__new_tag(),
    message: await ensureStrings.imageGeneration__tag_rules(), defaultValue: view.userTags.value.find(tag => tag.id === tagId)?.name });
  if (typeof label === 'string' && view.store.value?.storeId === storeId) await view.editTag({ tagId, name: label });
}
function chooseTag({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  view.filterTagId.value = view.userTags.value.find(tag => idToRaw({ id: tag.id }) === value)?.id;
}
async function curateRun({ runId, action }: { runId: ImageGenerationRunId, action: 'archive' | 'restore' }): Promise<void> {
  const sessionId = view.selectedSessionId.value, storeId = view.store.value?.storeId;
  const items = await view.runAssets({ runId });
  if (view.selectedSessionId.value === sessionId && view.store.value?.storeId === storeId) await view.curate({ items, action: { type: action } });
}
async function review(): Promise<void> {
  const tile = view.tiles.value[0];
  if (tile) await view.inspect({ tile });
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="min-w-0 space-y-3 @container/gallery" data-testid="workspace-gallery-area">
    <div tw-class="flex flex-wrap items-center gap-2">
      <button type="button" @click="mode = 'runs'" :aria-pressed="mode === 'runs'" :tw-class="['rounded-xl px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', mode === 'runs' ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800']">{{ lazyStrings.imageGeneration__runs() }}</button>
      <button type="button" @click="mode = 'gallery'" :aria-pressed="mode === 'gallery'" :tw-class="['rounded-xl px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', mode === 'gallery' ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800']">{{ lazyStrings.imageGeneration__gallery() }} · {{ view.total.value }}</button>
      <button type="button" @click="review" :disabled="!view.tiles.value.length" tw-class="rounded-xl px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__review() }}</button>
      <button type="button" @click="mode = 'compare'" :disabled="selection.length !== 2" :aria-pressed="mode === 'compare'" :tw-class="['rounded-xl px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', mode === 'compare' ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800']">{{ lazyStrings.imageGeneration__compare() }}</button>
    </div>
    <div tw-class="flex flex-wrap gap-2 items-center">
      <input v-model="text" type="search" :placeholder="lazyStrings.imageGeneration__search_images()" :aria-label="lazyStrings.imageGeneration__search_images()" tw-class="min-w-40 flex-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
      <button type="button" @click="onlyFavorite = !onlyFavorite" :aria-label="lazyStrings.imageGeneration__favorite()" :aria-pressed="onlyFavorite" :tw-class="['rounded-xl border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', onlyFavorite ? 'border-amber-300 dark:border-amber-700 text-amber-500 bg-amber-50 dark:bg-amber-950/20' : 'border-gray-200 dark:border-gray-700 text-gray-400']"><StarIcon tw-class="w-4 h-4" :fill="onlyFavorite ? 'currentColor' : 'none'" /></button>
      <span tw-class="relative"><select :value="view.filterTagId.value ? idToRaw({ id: view.filterTagId.value }) : ''" @change="chooseTag({ event: $event })" :aria-label="lazyStrings.imageGeneration__tags()" tw-class="appearance-none max-w-48 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">{{ lazyStrings.imageGeneration__all_tags() }}</option><option v-for="tag in view.userTags.value" :key="idToRaw({ id: tag.id })" :value="idToRaw({ id: tag.id })">{{ tag.name }}</option></select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-2.5 w-4 h-4 text-gray-400" /></span><button type="button" @click="tagsOpen = !tagsOpen" :aria-expanded="tagsOpen" :title="lazyStrings.imageGeneration__manage_tags()" :aria-label="lazyStrings.imageGeneration__manage_tags()" data-testid="workspace-manage-tags" tw-class="min-h-8 min-w-8 p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><TagsIcon aria-hidden="true" tw-class="w-4 h-4" /></button>
    </div>
    <div v-if="tagsOpen" data-testid="workspace-tag-manager" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2 text-xs">
      <div tw-class="flex flex-wrap gap-2"><button type="button" @click="editTag({ tagId: undefined })" :disabled="!view.store.value || view.mutation.value" tw-class="min-h-8 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__new_tag() }}</button><button v-for="tag in view.userTags.value" :key="idToRaw({ id: tag.id })" type="button" @click="editTag({ tagId: tag.id })" :disabled="view.mutation.value" :title="lazyStrings.imageGeneration__rename_tag()" tw-class="min-h-8 max-w-full break-words rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ tag.name }} · {{ lazyStrings.imageGeneration__rename() }}</button></div>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__tag_rules() }}</p>
    </div>
    <div tw-class="flex flex-wrap items-center gap-2">
      <button v-for="choice in ['active', 'archived', 'all'] as const" :key="choice" type="button" @click="view.visibility.value = choice" :aria-pressed="view.visibility.value === choice" :data-testid="'workspace-visibility-' + choice" :tw-class="['rounded-xl px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', view.visibility.value === choice ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800']">{{ choice === 'active' ? lazyStrings.imageGeneration__active_images() : choice === 'archived' ? lazyStrings.imageGeneration__archived_images() : lazyStrings.imageGeneration__all_images() }}</button>
      <span tw-class="ml-auto text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__newest_first() }}</span>
    </div>
    <p v-if="view.visibility.value === 'archived'" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__archive_help() }}</p>
    <div v-if="view.pendingDeletions.value.length" role="status" tw-class="rounded-xl border border-amber-200 dark:border-amber-800 p-3 text-xs space-y-2"><p>{{ lazyStrings.imageGeneration__pending_deletions() }}</p><button type="button" @click="view.retryDeletions()" :disabled="view.mutation.value" tw-class="rounded-lg px-3 py-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40">{{ lazyStrings.imageGeneration__retry_deletions() }}</button></div>
    <div tw-class="flex flex-wrap items-center gap-2">
      <button type="button" @click="selection = [...view.tiles.value]" :disabled="!view.tiles.value.length || view.mutation.value" data-testid="workspace-select-loaded" tw-class="rounded-lg px-2 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40">{{ lazyStrings.imageGeneration__select_loaded() }}</button>
      <button v-if="selection.length" type="button" @click="selection = []" :disabled="view.mutation.value" tw-class="rounded-lg px-2 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40">{{ lazyStrings.imageGeneration__clear_selection() }}</button>
      <span v-if="selection.length" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__selected_images({ count: selection.length }) }}</span>
    </div>
    <ImageGenerationCurationActions v-if="selection.length" :view="view" :items="selection" />
    <p v-if="view.operationProgress.value" role="status" tw-class="text-xs text-gray-500">{{ view.operationProgress.value.completed }} / {{ view.operationProgress.value.total }}</p>

    <ImageGenerationCompare v-if="mode === 'compare'" :view="view" />
    <template v-else>
      <p v-if="view.loading.value" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__loading() }}</p>
      <p v-if="!view.tiles.value.length && !view.loading.value" tw-class="rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 px-5 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">{{ lazyStrings.imageGeneration__empty_gallery() }}</p>
      <div v-if="mode === 'gallery'" tw-class="grid grid-cols-2 @[30rem]/gallery:grid-cols-3 @[46rem]/gallery:grid-cols-4 gap-3"><ImageGenerationAssetCard :prompt="runById.get(tile.runId)?.prompt" v-for="tile in view.tiles.value" :key="idToRaw({ id: tile.id })" :tile="tile" :view="view" /></div>
      <div v-else tw-class="space-y-5">
        <section v-for="group in groupedRuns" :key="idToRaw({ id: group.run.id })" tw-class="space-y-3" data-testid="workspace-run">
          <header tw-class="border-t border-gray-200 dark:border-gray-700 pt-3 space-y-1"><div tw-class="flex items-start gap-2"><p tw-class="min-w-0 flex-1 line-clamp-2 text-sm leading-relaxed font-medium break-words select-text">{{ group.run.prompt }}</p><ImageGenerationCopyButton :text="group.run.prompt" :label="lazyStrings.imageGeneration__copy_prompt()" data-testid="workspace-copy-run-prompt" /></div><p tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ group.run.modelName }} · {{ statusLabel({ execution: group.run.execution }) }} · {{ group.run.requestedCount }}</p><p v-if="group.run.execution.type === 'running' || group.run.execution.type === 'queued'" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__interrupted_help() }}</p><p v-if="group.run.execution.type === 'failed'" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ group.run.execution.message }}</p>
            <div v-if="group.run.execution.type !== 'running' && group.run.execution.type !== 'queued'" tw-class="flex gap-2">
              <button type="button" @click="curateRun({ runId: group.run.id, action: 'archive' })" :disabled="view.mutation.value" data-testid="workspace-archive-run" tw-class="rounded-lg px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.imageGeneration__archive_run() }}</button>
              <button type="button" @click="curateRun({ runId: group.run.id, action: 'restore' })" :disabled="view.mutation.value" tw-class="rounded-lg px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.imageGeneration__restore_run() }}</button>
            </div>
          </header>
          <div tw-class="grid grid-cols-2 @[30rem]/gallery:grid-cols-3 @[46rem]/gallery:grid-cols-4 gap-3"><ImageGenerationAssetCard v-for="tile in group.images" :key="idToRaw({ id: tile.id })" :tile="tile" :view="view" /></div>
        </section>
      </div>
      <button v-if="view.nextCursor.value" type="button" @click="view.refresh({ append: true })" :disabled="view.loading.value" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-3 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__load_more() }}</button>
    </template>
  </section>
</template>
