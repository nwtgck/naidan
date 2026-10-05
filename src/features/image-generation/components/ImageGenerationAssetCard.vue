<script setup lang="ts">
import { StarIcon, CheckIcon, ArchiveIcon, ArchiveRestoreIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { ImageGenerationTagReference } from '@/01-models/image-generation';
import type { ImageGenerationTile, ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageHistoryImage from './ImageHistoryImage.vue';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
const props = defineProps<{ tile: ImageGenerationTile, view: ImageGenerationWorkspaceView, prompt?: string }>();
function tagLabel({ tag }: { tag: ImageGenerationTagReference }): string | undefined {
  switch (tag.type) {
  case 'system': return lazyStrings.imageGeneration__favorite();
  case 'user': return props.view.catalog.value?.tags.find(value => value.id === tag.tagId)?.name ?? idToRaw({ id: tag.tagId });
  default: { const exhaustive: never = tag; throw new Error(String(exhaustive)); }
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <article tw-class="min-w-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden shadow-sm" data-testid="workspace-asset">
    <p v-if="tile.confirmation === 'unconfirmed'" data-testid="asset-unconfirmed" tw-class="px-2 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">{{ lazyStrings.ImageRecoveredOutputs__unconfirmed() }}</p>
    <button type="button" @click="view.inspect({ tile })" :aria-label="lazyStrings.imageGeneration__inspect()" tw-class="w-full block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500">
      <ImageHistoryImage :binary-object-id="tile.binaryObjectId" :width="tile.width" :height="tile.height" :alt="tile.seed" :get-image="view.getImage" thumbnail />
    </button>
    <div tw-class="p-2 space-y-2">
      <div v-if="prompt !== undefined" tw-class="flex items-start gap-1"><p tw-class="min-w-0 flex-1 line-clamp-2 text-xs leading-relaxed text-gray-600 dark:text-gray-300 break-words select-text">{{ prompt }}</p><ImageGenerationCopyButton :text="prompt" :label="lazyStrings.imageGeneration__copy_prompt()" data-testid="workspace-copy-card-prompt" /></div>
      <div tw-class="flex items-center justify-between gap-1">
        <span tw-class="min-w-0 text-[10px] font-mono text-gray-500 dark:text-gray-400 break-all" :title="tile.confirmation === 'unconfirmed' ? lazyStrings.ImageGenerationHistory__requested_seed() : lazyStrings.imageGeneration__actual_seed()">{{ tile.seed }}</span>
        <div tw-class="flex shrink-0">
          <button type="button" @click="view.toggleTag({ tile, tag: { type: 'system', key: 'favorite' } })" :disabled="view.mutation.value || !tile.annotations" :aria-label="lazyStrings.imageGeneration__favorite()" :aria-pressed="view.hasTag({ tile, tag: { type: 'system', key: 'favorite' } })" :tw-class="['p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40', view.hasTag({ tile, tag: { type: 'system', key: 'favorite' } }) ? 'text-amber-500' : 'text-gray-400']"><StarIcon :fill="view.hasTag({ tile, tag: { type: 'system', key: 'favorite' } }) ? 'currentColor' : 'none'" tw-class="w-4 h-4" /></button>
          <button type="button" @click="view.toggleSelection({ tile })" :aria-label="lazyStrings.imageGeneration__select_image()" :aria-pressed="view.selection.value.some(value => value.id === tile.id)" :disabled="view.mutation.value" :tw-class="['p-1.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-30', view.selection.value.some(value => value.id === tile.id) ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"><CheckIcon tw-class="w-4 h-4" /></button>
          <button type="button" @click="view.curate({ items: [tile], action: { type: tile.annotations?.state === 'archived' ? 'restore' : 'archive' } })" :disabled="view.mutation.value || !tile.annotations" :aria-label="tile.annotations?.state === 'archived' ? lazyStrings.imageGeneration__restore() : lazyStrings.imageGeneration__archive()" data-testid="workspace-card-archive" tw-class="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><ArchiveRestoreIcon v-if="tile.annotations?.state === 'archived'" tw-class="w-4 h-4" /><ArchiveIcon v-else tw-class="w-4 h-4" /></button>
        </div>
      </div>
      <div v-if="tile.annotations?.tags.length" tw-class="flex flex-wrap gap-1"><span v-for="(assignment, index) in tile.annotations.tags" :key="index" tw-class="max-w-full truncate rounded-md px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-[10px] text-gray-600 dark:text-gray-300">{{ tagLabel({ tag: assignment.tag }) }}</span></div>
      <ImageSettingsSection v-if="view.userTags.value.length" :title="lazyStrings.imageGeneration__tags()" :summary="undefined" embedded compact><div tw-class="mt-2 flex flex-wrap gap-1">
        <button v-for="tag in view.userTags.value" :key="idToRaw({ id: tag.id })" type="button" :disabled="view.mutation.value || !tile.annotations" @click="view.toggleTag({ tile, tag: { type: 'user', tagId: tag.id } })" :aria-label="lazyStrings.imageGeneration__apply_tag() + ': ' + tag.name" :aria-pressed="view.hasTag({ tile, tag: { type: 'user', tagId: tag.id } })" :tw-class="['max-w-full break-words rounded-lg border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', view.hasTag({ tile, tag: { type: 'user', tagId: tag.id } }) ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700']">{{ tag.name }}</button>
      </div></ImageSettingsSection>
    </div>
  </article>
</template>
