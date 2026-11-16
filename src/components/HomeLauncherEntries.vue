<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { ChevronRightIcon } from 'lucide-vue-next';
import { useLauncherEntries } from '@/composables/useLauncherEntries';
import { lazyStrings } from '@/strings';
import LauncherCategoryTabs from './LauncherCategoryTabs.vue';

const props = defineProps<{ query: string, blocked: boolean }>();
const emit = defineEmits<{ navigate: [] }>();
const { category, entries, follow, pathFor, navigationError, allEntries } = useLauncherEntries({ query: () => props.query, blocked: () => props.blocked });

async function open({ event, path }: { event: MouseEvent, path: string }): Promise<void> {
  if (await follow({ event, path })) {
    emit('navigate');
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section data-testid="home-launcher-entry-list" :aria-label="lazyStrings.launcher__features()" tw-class="@container">
    <LauncherCategoryTabs v-model:category="category" :blocked="blocked" tw-class="mb-[7px] min-h-10" />
    <!-- Keep filtered cards as invisible, inert sizing content so categories
         reserve the same height even when translations wrap differently. -->
    <div tw-class="relative">
      <div tw-class="grid auto-rows-fr grid-cols-2 gap-2 @[600px]:grid-cols-3 @[880px]:grid-cols-4">
        <template v-for="entry in allEntries" :key="entry.forKey">
          <RouterLink v-if="entry.destination.kind !== 'unimplemented'" :to="pathFor({ destination: entry.destination })" custom v-slot="{ href }">
            <a :href="href" :inert="blocked || !entries.includes(entry) || undefined" :data-testid="entries.includes(entry) ? 'launcher-entry' : undefined" :aria-hidden="!entries.includes(entry) || undefined" :class="{ 'home-entry-hidden': !entries.includes(entry) }" :style="{ order: entries.includes(entry) ? entries.indexOf(entry) : allEntries.length }" @click="open({ event: $event, path: pathFor({ destination: entry.destination }) })" tw-class="group flex min-h-[69px] min-w-0 items-center gap-[9px] rounded-xl border border-gray-200 bg-white/70 px-[11px] py-2.5 text-left transition-colors duration-150 hover:border-blue-300/60 hover:bg-blue-50/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none dark:border-gray-700/80 dark:bg-gray-800/40 dark:hover:border-gray-500 dark:hover:bg-gray-800/80">
              <span tw-class="grid h-[29px] w-[29px] shrink-0 place-items-center rounded-[7px] bg-blue-500/[0.07] text-blue-600 dark:text-blue-300"><component :is="entry.icon" aria-hidden="true" class="home-entry-icon" tw-class="h-[18px] w-[18px]" /></span>
              <span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-semibold leading-[1.3] text-gray-800 dark:text-gray-100">{{ entry.title() }}</span><span tw-class="mt-1 block text-[10px] leading-[1.4] text-gray-500 dark:text-gray-400">{{ entry.description() }}</span></span>
              <ChevronRightIcon aria-hidden="true" tw-class="hidden h-3.5 w-3.5 shrink-0 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none @[480px]:block dark:text-gray-500" />
            </a>
          </RouterLink>
          <div v-else :inert="!entries.includes(entry) || undefined" :data-testid="entries.includes(entry) ? 'launcher-entry' : undefined" :aria-hidden="!entries.includes(entry) || undefined" :class="{ 'home-entry-hidden': !entries.includes(entry) }" :style="{ order: entries.includes(entry) ? entries.indexOf(entry) : allEntries.length }" aria-disabled="true" tw-class="flex min-h-[69px] min-w-0 items-center gap-[9px] rounded-xl border border-gray-200 bg-gray-50/60 px-[11px] py-2.5 text-left dark:border-gray-700/80 dark:bg-gray-800/30">
            <span tw-class="grid h-[29px] w-[29px] shrink-0 place-items-center rounded-[7px] bg-blue-500/[0.07] text-blue-500 dark:text-blue-300/80"><component :is="entry.icon" aria-hidden="true" class="home-entry-icon" tw-class="h-[18px] w-[18px]" /></span>
            <span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-semibold leading-[1.3] text-gray-600 dark:text-gray-300">{{ entry.title() }}</span><span tw-class="mt-1 block text-[10px] leading-[1.4] text-gray-500 dark:text-gray-400">{{ entry.description() }}</span></span>
          </div>
        </template>
      </div>
      <p v-if="entries.length === 0" role="status" data-testid="launcher-empty" tw-class="absolute inset-0 flex items-center justify-center text-center text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.launcher__no_matching_features() }}</p>
    </div>
    <p v-if="navigationError" role="alert" tw-class="mt-3 break-words text-xs text-red-600 dark:text-red-400">{{ navigationError }}</p>
  </section>
</template>

<style scoped>
.home-entry-hidden {
  visibility: hidden;
  pointer-events: none;
}

.home-entry-icon {
  filter: drop-shadow(0 0 5px rgb(96 165 250 / 22%));
}
</style>
