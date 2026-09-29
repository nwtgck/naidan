<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { Trash2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { AudioReferenceEntry } from '@/features/audio-generation/composables/useAudioReferences';
const props = defineProps<{ entry: AudioReferenceEntry, selected: boolean, disabled: boolean }>();
const emit = defineEmits<{ select: [checked: boolean], remove: [] }>();
const player = ref<HTMLAudioElement>();
function select({ event }: { event: Event }): void {
  if (!props.disabled && event.target instanceof HTMLInputElement) emit('select', event.target.checked);
}
onBeforeUnmount(() => {
  if (!player.value) return;
  player.value.pause(); player.value.removeAttribute('src'); player.value.load();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="audio-reference-entry" :data-reference-id="entry.id" tw-class="min-w-0 space-y-2 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
    <div tw-class="flex min-w-0 items-center gap-2">
      <label tw-class="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <input type="checkbox" :checked="selected" :disabled="disabled" @change="select({ event: $event })" data-testid="audio-reference-selected" />
        <span tw-class="min-w-0 break-all">{{ entry.file.name }}</span>
      </label>
      <button type="button" :disabled="disabled" @click="emit('remove')" :aria-label="lazyStrings.audioGeneration__delete_reference()" :title="lazyStrings.audioGeneration__delete_reference()" data-testid="audio-reference-delete" tw-class="shrink-0 rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"><Trash2Icon tw-class="h-4 w-4" /></button>
    </div>
    <audio ref="player" :src="entry.url" controls preload="none" :aria-label="entry.file.name" data-testid="audio-reference-player" tw-class="w-full min-w-0" />
  </div>
</template>
