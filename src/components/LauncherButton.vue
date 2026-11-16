<script setup lang="ts">
import { computed } from 'vue';
import { LayoutGridIcon } from 'lucide-vue-next';
import { useLauncher } from '@/composables/useLauncher';
import { useAppEntry } from '@/composables/useAppEntry';
import { isAppInteractionEnabled, useAppPresentation } from '@/composables/useAppPresentation';
import { lazyStrings } from '@/strings';

defineProps<{ expanded: boolean }>();
const { openLauncher } = useLauncher();
const entry = useAppEntry();
const { appInteraction } = useAppPresentation();
const blocked = computed(() => entry.interaction.value !== 'ready' || !isAppInteractionEnabled({ interaction: appInteraction.value }));

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <button type="button" data-testid="open-launcher" :disabled="blocked" :title="lazyStrings.launcher__more_features()" :aria-label="lazyStrings.launcher__more_features()" aria-haspopup="dialog" @click="openLauncher({ view: 'entries' })" :tw-class="['flex min-h-9 items-center gap-2 rounded-xl text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100', expanded ? 'w-full px-3 py-2' : 'mx-auto h-8 w-8 justify-center']">
    <LayoutGridIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
    <span v-if="expanded" tw-class="min-w-0 flex-1 text-left">{{ lazyStrings.launcher__more_features() }}</span>
  </button>
</template>
