<script setup lang="ts">
import { useId } from 'vue';
import { ArrowRightIcon, Loader2Icon } from 'lucide-vue-next';
import { useLauncher } from '@/composables/useLauncher';
import { useDeveloperTools } from '@/composables/useDeveloperTools';
import { developerToolSections as sections, developerToolAvailable as available, developerToolUnavailableReason as unavailableReason } from '@/logic/developer-tools';

const emit = defineEmits<{ openModelSupportInvestigation: [], navigate: [focus: 'restore' | 'handoff'] }>();
const id = useId();
const { opener: launcherOpener } = useLauncher();
const { entries, interactive, opening, navigationError, open } = useDeveloperTools({
  settingsOpener: launcherOpener,
  onModelSupport: () => emit('openModelSupportInvestigation'),
  onNavigate: ({ focus }) => emit('navigate', focus),
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="space-y-6" data-testid="developer-tools-panel">
    <section v-for="section in sections" :key="section.id" :aria-labelledby="`${id}-developer-tools-${section.id}`" tw-class="space-y-2">
      <h3 :id="`${id}-developer-tools-${section.id}`" tw-class="px-3 text-xs font-medium text-gray-500 dark:text-gray-400">{{ section.title() }}</h3>
      <div tw-class="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <button v-for="entry in entries.filter(item => item.section === section.id)" :key="entry.id" type="button" :disabled="!interactive || opening !== undefined || !available({ entry })" :aria-busy="opening === entry.id" :data-testid="`developer-tool-${entry.id}`" tw-class="group flex min-h-20 min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-gray-800 dark:disabled:hover:bg-transparent" @click="open({ entry, opener: $event.currentTarget ?? undefined })">
          <span tw-class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"><component :is="entry.icon" aria-hidden="true" tw-class="h-4 w-4" /></span>
          <span tw-class="min-w-0 flex-1 space-y-1"><span tw-class="block break-words text-sm font-medium leading-5 text-gray-700 dark:text-gray-200">{{ entry.title() }}</span><span tw-class="block text-xs leading-5 text-gray-500 dark:text-gray-400">{{ entry.description() }}</span><span v-if="!available({ entry })" tw-class="block text-[11px] leading-4 text-gray-500 dark:text-gray-400">{{ unavailableReason({ entry }) }}</span></span>
          <Loader2Icon v-if="opening === entry.id" aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin text-gray-400 motion-reduce:animate-none" /><ArrowRightIcon v-else-if="available({ entry })" aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </div>
    </section>
    <p v-if="navigationError" role="alert" tw-class="break-words px-3 text-xs text-red-600 dark:text-red-400" data-testid="developer-tools-navigation-error">{{ navigationError }}</p>
  </div>
</template>
