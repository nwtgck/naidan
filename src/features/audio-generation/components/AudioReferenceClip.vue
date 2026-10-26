<script setup lang="ts">
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { onBeforeUnmount, ref } from 'vue';
import { Trash2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { AudioReferenceEntry } from '@/features/audio-generation/composables/useAudioReferences';
import ResourceLoadCspHint from '@/components/ResourceLoadCspHint.vue';
const props = defineProps<{ entry: AudioReferenceEntry, selected: boolean, disabled: boolean }>();
const emit = defineEmits<{ select: [checked: boolean], remove: [] }>();
const player = ref<HTMLAudioElement>();

function select({ event }: { event: Event }): void {
  if (!props.disabled && event.target instanceof HTMLInputElement) {
    emit('select', event.target.checked);
  }
}

onBeforeUnmount(() => {
  if (!player.value) {
    return;
  }
  player.value.pause();
  player.value.removeAttribute('src');
  player.value.load();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="audio-reference-entry" :data-reference-id="entry.id" :tw-class="['min-w-0 space-y-3 rounded-xl border p-3 transition-colors', selected ? 'border-blue-200/80 bg-blue-50/30 dark:border-blue-500/25 dark:bg-blue-500/5' : 'border-gray-200/70 bg-white dark:border-gray-700/60 dark:bg-gray-900/30']">
    <div tw-class="flex min-w-0 items-center gap-2">
      <label tw-class="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-3 text-xs font-medium text-gray-700 dark:text-gray-200">
        <SettingsChoiceControl presentation="checkbox"><input type="checkbox" :checked="selected" :disabled="disabled" @change="select({ event: $event })" data-testid="audio-reference-selected" /></SettingsChoiceControl>
        <span tw-class="min-w-0 break-all">{{ entry.file.name }}</span>
      </label>
      <button type="button" :disabled="disabled" @click="emit('remove')" :aria-label="lazyStrings.audioGeneration__delete_reference()" :title="lazyStrings.audioGeneration__delete_reference()" data-testid="audio-reference-delete" tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 disabled:opacity-40 dark:hover:bg-red-500/10"><Trash2Icon tw-class="h-4 w-4" /></button>
    </div>
    <audio ref="player" :src="entry.url" controls preload="none" :aria-label="entry.file.name" data-testid="audio-reference-player" tw-class="w-full min-w-0" />
    <ResourceLoadCspHint :resources="[{ element: player, url: entry.url, destination: 'media' }]" />
  </div>
</template>
