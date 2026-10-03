<script setup lang="ts">
import { ref } from 'vue';
import { idToRaw, type ImageGenerationTagId } from '@/01-models/ids';
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, StarIcon, Trash2Icon, TagsIcon } from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';
import { ensureStrings, lazyStrings } from '@/strings';
import type { ImageGenerationTile, ImageGenerationWorkspaceView } from '@/features/stable-diffusion-cpp-browser/composables/use-image-generation-workspace';
const props = defineProps<{ view: ImageGenerationWorkspaceView, items: ImageGenerationTile[] }>();
const { showConfirm } = useConfirm();
const selectedTagId = ref<ImageGenerationTagId>();
const tagsOpen = ref(false);
function chooseTag({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const raw = event.target.value;
  selectedTagId.value = props.view.userTags.value.find(tag => idToRaw({ id: tag.id }) === raw)?.id;
}
async function tagImages({ assignment }: { assignment: 'add' | 'remove' }): Promise<void> {
  const tagId = selectedTagId.value;
  if (!tagId || !props.view.userTags.value.some(tag => tag.id === tagId)) return;
  await props.view.curate({ items: props.items, action: { type: 'tag', tag: { type: 'user', tagId }, assignment } });
}
async function remove(): Promise<void> {
  const items = [...props.items], storeId = props.view.store.value?.storeId, sessionId = props.view.selectedSessionId.value;
  if (!items.length || !storeId || props.view.mutation.value) return;
  if (!await showConfirm({ title: await ensureStrings.imageGeneration__delete_images(), message: await ensureStrings.imageGeneration__delete_images_notice({ count: items.length }), confirmButtonVariant: 'danger', confirmButtonText: await ensureStrings.imageGeneration__delete_images() })) return;
  if (props.view.store.value?.storeId !== storeId || props.view.selectedSessionId.value !== sessionId) return;
  await props.view.curate({ items, action: { type: 'delete' } });
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2 text-xs" data-testid="workspace-curation-actions">
    <div tw-class="flex flex-wrap items-center gap-1.5">
      <button type="button" @click="view.curate({ items, action: { type: 'tag', tag: { type: 'system', key: 'favorite' }, assignment: 'add' } })" :disabled="!items.length || view.mutation.value" :title="lazyStrings.imageGeneration__favorite()" :aria-label="lazyStrings.imageGeneration__favorite()" data-testid="workspace-bulk-favorite" tw-class="flex items-center gap-1.5 min-h-8 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/20 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><StarIcon tw-class="w-4 h-4" /></button>
      <button type="button" @click="view.curate({ items, action: { type: 'tag', tag: { type: 'system', key: 'favorite' }, assignment: 'remove' } })" :disabled="!items.length || view.mutation.value" tw-class="min-h-8 rounded-lg px-2.5 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__unfavorite() }}</button>
      <button v-if="items.some(item => item.annotations?.state === 'active')" type="button" @click="view.curate({ items, action: { type: 'archive' } })" :disabled="view.mutation.value" data-testid="workspace-bulk-archive" tw-class="flex items-center gap-1.5 min-h-8 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><ArchiveIcon tw-class="w-4 h-4" />{{ lazyStrings.imageGeneration__archive() }}</button>
      <button v-if="items.some(item => item.annotations?.state === 'archived')" type="button" @click="view.curate({ items, action: { type: 'restore' } })" :disabled="view.mutation.value" data-testid="workspace-bulk-restore" tw-class="flex items-center gap-1.5 min-h-8 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><ArchiveRestoreIcon tw-class="w-4 h-4" />{{ lazyStrings.imageGeneration__restore() }}</button>
      <button v-if="items.length > 1" type="button" @click="tagsOpen = !tagsOpen" :aria-expanded="tagsOpen" data-testid="workspace-bulk-tags-toggle" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><TagsIcon tw-class="w-4 h-4" />{{ lazyStrings.imageGeneration__tags() }}</button>
      <button type="button" @click="remove" :disabled="!items.length || view.mutation.value || view.editor.busy.value || view.hasPendingSave.value" data-testid="workspace-bulk-delete" tw-class="flex items-center gap-1.5 min-h-8 rounded-lg px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><Trash2Icon tw-class="w-4 h-4" />{{ lazyStrings.imageGeneration__delete_images() }}</button>
    </div>
    <div v-if="items.length > 1 && tagsOpen" data-testid="workspace-bulk-tags-panel" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 text-xs">
      <div tw-class="flex flex-wrap items-center gap-2">
        <span tw-class="relative min-w-40 flex-1"><select :value="selectedTagId ? idToRaw({ id: selectedTagId }) : ''" @change="chooseTag({ event: $event })" :aria-label="lazyStrings.imageGeneration__tags()" data-testid="workspace-bulk-tag-choice" :disabled="view.mutation.value" tw-class="appearance-none w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40"><option value="">{{ lazyStrings.imageGeneration__tags() }}</option><option v-for="tag in view.userTags.value" :key="idToRaw({ id: tag.id })" :value="idToRaw({ id: tag.id })">{{ tag.name }}</option></select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-2.5 w-4 h-4 text-gray-400" /></span>
        <button type="button" @click="tagImages({ assignment: 'add' })" :disabled="!selectedTagId || view.mutation.value" data-testid="workspace-bulk-tag-add" tw-class="min-h-8 rounded-lg px-2.5 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__add_tag() }}</button>
        <button type="button" @click="tagImages({ assignment: 'remove' })" :disabled="!selectedTagId || view.mutation.value" data-testid="workspace-bulk-tag-remove" tw-class="min-h-8 rounded-lg px-2.5 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__remove_tag() }}</button>
      </div>
    </div>
  </div>
</template>
