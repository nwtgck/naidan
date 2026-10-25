<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from 'vue';
import { Loader2Icon, ShieldCheckIcon } from 'lucide-vue-next';
import type { NaidanLicenseCatalog } from '@/01-models/naidan-license';
import { lazyStrings } from '@/strings';
import OpenSourceLicenseText from './OpenSourceLicenseText.vue';

const catalog = shallowRef<NaidanLicenseCatalog>();
const openIndexes = shallowRef<ReadonlySet<number>>(new Set());
const isLoadingLicenses = shallowRef(true);
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
  if (!(details instanceof HTMLDetailsElement) || details.open === openIndexes.value.has(index)) {
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
  <section tw-class="space-y-6">
    <div tw-class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
      <ShieldCheckIcon tw-class="w-5 h-5 text-blue-500" />
      <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.AboutTab__open_source_licenses() }}</h2>
    </div>

    <p tw-class="text-sm font-medium text-gray-500 dark:text-gray-400">
      {{ lazyStrings.AboutTab__built_with_open_source_software() }}
    </p>

    <div data-testid="oss-license-list" tw-class="border border-gray-100 dark:border-gray-800 rounded-3xl overflow-hidden bg-white dark:bg-gray-900 min-h-[100px] flex flex-col items-center justify-center">
      <div v-if="isLoadingLicenses" data-testid="oss-license-loading" tw-class="p-12 flex flex-col items-center gap-3">
        <Loader2Icon tw-class="w-6 h-6 text-blue-500 animate-spin" />
        <p tw-class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.AboutTab__loading_licenses() }}</p>
      </div>
      <div v-else tw-class="w-full max-h-[400px] overflow-y-auto p-2 space-y-1 overscroll-contain">
        <div
          v-for="(license, index) in catalog?.entries"
          :key="index"
          data-testid="oss-license-item"
          tw-class="p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-2xl transition-colors group"
        >
          <div tw-class="flex items-start justify-between gap-4">
            <div tw-class="min-w-0">
              <div tw-class="flex items-center gap-2">
                <span tw-class="text-sm font-bold text-gray-800 dark:text-white truncate">{{ license.name || lazyStrings.AboutTab__unknown_package() }}</span>
                <span v-if="license.version !== null" tw-class="text-[10px] font-bold text-gray-400">v{{ license.version }}</span>
                <span v-if="license.origin" tw-class="text-[10px] font-bold text-gray-400">{{ license.origin }}</span>
              </div>
              <div tw-class="text-[10px] font-bold text-blue-600/70 dark:text-blue-400/60 uppercase tracking-tight mt-0.5">{{ license.license }}</div>
            </div>
          </div>
          <details data-testid="oss-license-details" tw-class="mt-3" @toggle="updateOpenLicense({ event: $event, index })">
            <summary tw-class="text-[10px] font-bold text-gray-400 cursor-pointer hover:text-gray-600 dark:hover:text-gray-200 transition-colors list-none flex items-center gap-1">
              {{ lazyStrings.AboutTab__view_license_text() }}
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
