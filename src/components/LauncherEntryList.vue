<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { ChevronRightIcon } from 'lucide-vue-next';
import { useLauncherEntries } from '@/composables/useLauncherEntries';
import { lazyStrings } from '@/strings';
import LauncherCategoryTabs from './LauncherCategoryTabs.vue';

const props = defineProps<{ query: string, blocked: boolean }>();
const emit = defineEmits<{ navigate: [] }>();
const { category, entries, follow, pathFor, navigationError } = useLauncherEntries({ query: () => props.query, blocked: () => props.blocked });

async function open({ event, path }: { event: MouseEvent, path: string }): Promise<void> {
  if (await follow({ event, path })) {
    emit('navigate');
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section data-testid="launcher-entry-list" :aria-label="lazyStrings.launcher__features()" tw-class="flex min-h-0 flex-1 flex-col">
    <LauncherCategoryTabs v-model:category="category" :blocked="blocked" tw-class="min-h-[54px] border-b border-gray-200/70 px-5 dark:border-gray-800 sm:min-h-[63px] sm:px-7" />
    <div tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6">
      <div tw-class="grid grid-cols-1 gap-x-3 gap-y-1 min-[431px]:grid-cols-2">
        <template v-for="entry in entries" :key="entry.forKey">
          <RouterLink v-if="entry.destination.kind !== 'unimplemented'" :to="pathFor({ destination: entry.destination })" custom v-slot="{ href }">
            <a :href="href" :inert="blocked || undefined" data-testid="launcher-entry" @click="open({ event: $event, path: pathFor({ destination: entry.destination }) })" tw-class="group flex min-h-[68px] min-w-0 items-center gap-3 rounded-xl px-3 py-[9px] text-left transition-colors duration-150 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 motion-reduce:transition-none dark:hover:bg-gray-800">
              <span tw-class="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-xl bg-blue-500/[0.095] text-blue-600 dark:text-blue-300"><component :is="entry.icon" aria-hidden="true" class="launcher-entry-icon" tw-class="h-[21px] w-[21px]" /></span>
              <span tw-class="min-w-0 flex-1"><span tw-class="block text-[13.5px] font-semibold leading-[1.25] text-gray-800 dark:text-gray-100">{{ entry.title() }}</span><span tw-class="mt-[5px] block text-[11px] leading-[1.4] text-gray-500 dark:text-gray-400">{{ entry.description() }}</span></span>
              <ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none dark:text-gray-500" />
            </a>
          </RouterLink>
          <div v-else data-testid="launcher-entry" aria-disabled="true" tw-class="flex min-h-[68px] min-w-0 items-center gap-3 rounded-xl px-3 py-[9px] text-left">
            <span tw-class="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-xl bg-blue-500/[0.095] text-blue-500 dark:text-blue-300/80"><component :is="entry.icon" aria-hidden="true" class="launcher-entry-icon" tw-class="h-[21px] w-[21px]" /></span>
            <span tw-class="min-w-0 flex-1"><span tw-class="block text-[13.5px] font-semibold leading-[1.25] text-gray-600 dark:text-gray-300">{{ entry.title() }}</span><span tw-class="mt-[5px] block text-[11px] leading-[1.4] text-gray-500 dark:text-gray-400">{{ entry.description() }}</span></span>
          </div>
        </template>
      </div>
      <p v-if="entries.length === 0" role="status" data-testid="launcher-empty" tw-class="py-12 text-center text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.launcher__no_matching_features() }}</p>
      <p v-if="navigationError" role="alert" tw-class="mt-3 break-words text-xs text-red-600 dark:text-red-400">{{ navigationError }}</p>
    </div>
  </section>
</template>

<style scoped>
.launcher-entry-icon {
  filter: drop-shadow(0 0 5px rgb(96 165 250 / 22%));
}
</style>
