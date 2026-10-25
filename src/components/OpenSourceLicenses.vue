<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { ChevronRightIcon, Loader2Icon, ShieldCheckIcon } from 'lucide-vue-next';
import type { NaidanLicenseCatalog } from '@/01-models/naidan-license';
import { lazyStrings } from '@/strings';
import OpenSourceLicenseText from './OpenSourceLicenseText.vue';
import OpenSourceLicenseFilter from './OpenSourceLicenseFilter.vue';

const catalog = shallowRef<NaidanLicenseCatalog>();
const openIndexes = shallowRef<ReadonlySet<number>>(new Set());
const isLoadingLicenses = shallowRef(true);
const filterQuery = ref('');
const listRoot = ref<HTMLDivElement>();
const filteredEntries = computed(() => {
  const terms = filterQuery.value.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return (catalog.value?.entries ?? []).map((license, index) => ({ license, index })).filter(({ license }) => {
    const { id: _id, name, version, origin, license: licenseName, ...unhandled } = license;
    unhandled satisfies Record<PropertyKey, never>;
    const text = [name, version, origin, licenseName].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  });
});
// Evaluate during catalog teardown too, before Vue stops the watcher, so its
// derived metadata cache is cleared along with the owned catalog.
watch(filteredEntries, entries => {
  const visibleIndexes = new Set(entries.map(entry => entry.index));
  const next = new Set([...openIndexes.value].filter(index => visibleIndexes.has(index)));
  if (next.size !== openIndexes.value.size) {
    // Filtered-out bodies are released; restoring the row starts it collapsed.
    openIndexes.value = next;
  }
}, { flush: 'sync' });
let requestEpoch = 0;

async function loadLicenses(): Promise<void> {
  const epoch = ++requestEpoch;
  try {
    // Cache only the module's factory, never a catalog or reconstructed bodies.
    const module = await import('virtual:naidan-licenses');
    if (epoch !== requestEpoch) {
      return;
    }
    catalog.value = module.default();
  } catch (error) {
    if (epoch === requestEpoch) {
      console.error('Failed to load licenses:', error);
    }
  } finally {
    if (epoch === requestEpoch) {
      isLoadingLicenses.value = false;
    }
  }
}

function updateOpenLicense({ event, index }: { event: Event, index: number }): void {
  const details = event.currentTarget;
  // A native toggle task can outlive the details node removed by filtering.
  if (!(details instanceof HTMLDetailsElement) || !listRoot.value?.contains(details) || !filteredEntries.value.some(entry => entry.index === index) || details.open === openIndexes.value.has(index)) {
    return;
  }
  const next = new Set(openIndexes.value);
  if (details.open) {
    next.add(index);
  } else {
    next.delete(index);
  }
  openIndexes.value = next;
}

onMounted(loadLicenses);
onBeforeUnmount(() => {
  // import() cannot be cancelled. Invalidate it before it can create a catalog,
  // and drop the section's owned references during teardown.
  requestEpoch++;
  catalog.value = undefined;
  openIndexes.value = new Set();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      catalog,
      openIndexes,
    },
  }) || {}),
});
</script>

<template>
  <section tw-class="@container space-y-4">
    <div>
      <div tw-class="flex items-center gap-2.5 border-b border-gray-200/70 pb-4 dark:border-gray-800">
        <ShieldCheckIcon aria-hidden="true" tw-class="h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" />
        <h2 tw-class="text-lg font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.AboutTab__open_source_licenses() }}</h2>
      </div>
      <p tw-class="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__built_with_open_source_software() }}</p>
    </div>

    <div tw-class="space-y-2">
      <OpenSourceLicenseFilter
        v-model="filterQuery"
        :disabled="isLoadingLicenses"
        data-testid="oss-license-filter"
      />
      <p v-if="!isLoadingLicenses && filterQuery.trim().length > 0" data-testid="oss-license-match-count" role="status" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.OpenSourceLicenses__matching_packages({ count: filteredEntries.length, total: catalog?.entries.length ?? 0 }) }}</p>
    </div>

    <div ref="listRoot" data-testid="oss-license-list" :aria-busy="isLoadingLicenses" tw-class="min-h-24 overflow-hidden rounded-xl border border-gray-200/80 bg-white dark:border-gray-800 dark:bg-gray-900/30">
      <div v-if="isLoadingLicenses" data-testid="oss-license-loading" role="status" tw-class="flex min-h-24 items-center justify-center gap-2 p-4">
        <Loader2Icon aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin text-blue-500 dark:text-blue-400 motion-reduce:animate-none" />
        <p tw-class="text-sm text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__loading_licenses() }}</p>
      </div>
      <p v-else-if="filteredEntries.length === 0 && filterQuery.trim().length > 0" data-testid="oss-license-no-matches" tw-class="p-4 text-sm text-gray-600 dark:text-gray-300">{{ lazyStrings.OpenSourceLicenses__no_matching_packages() }}</p>
      <div v-else tw-class="max-h-[400px] divide-y divide-gray-200/70 overflow-y-auto overscroll-contain dark:divide-gray-800">
        <div
          v-for="{ license, index } in filteredEntries"
          :key="index"
          data-testid="oss-license-item"
          tw-class="min-w-0 px-4 py-2"
        >
          <details data-testid="oss-license-details" :open="openIndexes.has(index)" tw-class="group" @toggle="updateOpenLicense({ event: $event, index })">
            <summary tw-class="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 [&::-webkit-details-marker]:hidden">
              <span tw-class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span tw-class="break-all text-sm font-medium text-gray-800 dark:text-gray-100">{{ license.name || lazyStrings.AboutTab__unknown_package() }}</span>
                <span v-if="license.version !== null" tw-class="break-all text-xs text-gray-600 dark:text-gray-300">v{{ license.version }}</span>
                <span v-if="license.origin" tw-class="break-all text-xs text-gray-600 dark:text-gray-300">{{ license.origin }}</span>
                <span v-if="license.license" tw-class="break-words text-xs text-blue-600 dark:text-blue-400">{{ license.license }}</span>
              </span>
              <span tw-class="flex shrink-0 items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
                <span tw-class="sr-only @md:not-sr-only">{{ lazyStrings.AboutTab__view_license_text() }}</span>
                <ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-90 dark:text-gray-500 motion-reduce:transition-none" />
              </span>
            </summary>
            <OpenSourceLicenseText
              v-if="catalog !== undefined && openIndexes.has(index)"
              :index="index"
              :read-license-text="catalog.readLicenseText"
            />
          </details>
        </div>
      </div>
    </div>
  </section>
</template>
