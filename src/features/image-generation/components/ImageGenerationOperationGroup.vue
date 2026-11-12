<script setup lang="ts">
import { ref, useId } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
import type { ImageGenerationOperation } from '@/01-models/image-generation';
import { lazyStrings } from '@/strings';

defineProps<{ operation: ImageGenerationOperation | undefined }>();
defineSlots<{ actions?(): unknown, default(): unknown }>();
// The gallery keys this owner by operation identity. New result snapshots must
// not reopen a group that the person viewing the gallery has collapsed.
const open = ref(true);
const trigger = ref<HTMLButtonElement>();
const bodyId = useId();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section :tw-class="['min-w-0', operation && 'overflow-hidden rounded-xl border border-gray-200/80 bg-white/50 dark:border-gray-700/60 dark:bg-gray-900/30']">
    <header v-if="operation" tw-class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 bg-gray-50/70 px-2.5 py-1.5 dark:bg-gray-800/25">
      <button ref="trigger" type="button" :aria-expanded="open" :aria-controls="bodyId" @click="open = !open" data-testid="operation-toggle" tw-class="inline-flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-300 dark:hover:bg-gray-800">
        <ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none', !open && '-rotate-90']" />
        <span>{{ lazyStrings.imageComposition__operation() }}</span>
        <span tw-class="rounded-md bg-gray-100 px-1.5 py-0.5 text-xs tabular-nums text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ operation.runIds.length }}</span>
      </button>
      <div tw-class="min-w-0 max-w-full"><slot name="actions" /></div>
    </header>
    <SettingsCollapse :id="bodyId" :open="!operation || open" :return-focus="trigger">
      <div :tw-class="['min-w-0 space-y-3', operation && 'px-3 pb-3']"><slot /></div>
    </SettingsCollapse>
  </section>
</template>
