<script setup lang="ts">
import { useId } from 'vue';
import { useRoute } from 'vue-router';
import { Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useDeveloperTools } from '@/composables/useDeveloperTools';
import { developerToolSections as sections, developerToolAvailable as available, developerToolUnavailableReason as unavailableReason, type DeveloperToolEntry } from '@/logic/developer-tools';

defineProps<{ expanded: boolean }>();
const emit = defineEmits<{ openModelSupportInvestigation: [opener: HTMLElement | undefined] }>();
const id = useId();
const route = useRoute();
const { entries, interactive, opening, navigationError, open } = useDeveloperTools({
  settingsOpener: undefined,
  onModelSupport: ({ opener }) => emit('openModelSupportInvestigation', opener),
  onNavigate: undefined,
});

function current({ entry }: { entry: DeveloperToolEntry }): boolean {
  return entry.action.kind === 'route' && route.path.replace(/\/+$/, '') === entry.action.path;
}

function label({ entry }: { entry: DeveloperToolEntry }): string | undefined {
  return [entry.title(), unavailableReason({ entry })].filter(value => value !== undefined).join(' · ');
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <nav data-testid="developer-tools-sidebar" :aria-label="lazyStrings.launcher__developer_tools()" :tw-class="['min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-y-contain py-3', expanded ? 'px-3' : 'px-1']">
    <section v-for="section in sections" :key="section.id" :aria-labelledby="expanded ? `${id}-developer-sidebar-${section.id}` : undefined" :aria-label="!expanded ? section.title() : undefined" tw-class="space-y-1">
      <h2 v-if="expanded" :id="`${id}-developer-sidebar-${section.id}`" tw-class="px-2 pb-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">{{ section.title() }}</h2>
      <button v-for="entry in entries.filter(item => item.section === section.id)" :key="entry.id" type="button" :disabled="!interactive || opening !== undefined || !available({ entry })" :aria-current="current({ entry }) ? 'page' : undefined" :aria-busy="opening === entry.id" :aria-label="label({ entry })" :title="label({ entry })" :data-testid="`developer-sidebar-${entry.id}`" :tw-class="['flex min-h-9 w-full items-center gap-2 rounded-xl p-2 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50', current({ entry }) ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" @click="open({ entry, opener: $event.currentTarget ?? undefined })">
        <Loader2Icon v-if="opening === entry.id" aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /><component v-else :is="entry.icon" aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
        <span v-if="expanded" tw-class="min-w-0 flex-1"><span tw-class="block break-words leading-5">{{ entry.title() }}</span><span v-if="!available({ entry })" tw-class="block text-[10px] font-normal leading-4 text-gray-500 dark:text-gray-400">{{ unavailableReason({ entry }) }}</span></span>
      </button>
    </section>
    <p v-if="navigationError" role="alert" data-testid="developer-sidebar-navigation-error" tw-class="break-words px-2 text-xs text-red-600 dark:text-red-400">{{ navigationError }}</p>
  </nav>
</template>
