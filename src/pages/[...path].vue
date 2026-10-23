<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAppEntry } from '@/composables/useAppEntry';
import { hasModelEntryQuery } from '@/logic/startup/entry-intent';
import { lazyStrings } from '@/strings';

const router = useRouter();
const entry = useAppEntry();
const failed = ref(false);
let active = true;
let request: symbol | undefined;

async function recover(): Promise<void> {
  const route = router.currentRoute.value;
  if (!active || !('path' in route.params) || hasModelEntryQuery({ query: route.query })) {
    request = undefined;
    return;
  }
  const current = Symbol('unknown-page');
  request = current;
  failed.value = false;
  const isCurrent = () => active && request === current && router.currentRoute.value === route;
  try {
    await entry.recoverNotFound({ isCurrent });
  } catch {
    if (isCurrent()) {
      failed.value = true;
    }
  }
}

watch(() => router.currentRoute.value, recover, { immediate: true });
onScopeDispose(() => {
  active = false;
  request = undefined;
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="unknown-page-recovery" tw-class="flex h-full flex-col items-center justify-center gap-4 bg-[#fcfcfd] p-6 text-center text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">
    <template v-if="failed">
      <p role="alert">{{ lazyStrings.NotFoundPage__could_not_open_page() }}</p>
      <button type="button" data-testid="unknown-page-retry" tw-class="rounded-lg border border-gray-200 bg-white px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700" @click="recover">{{ lazyStrings.NotFoundPage__retry() }}</button>
    </template>
    <p v-else role="status">{{ lazyStrings.NotFoundPage__returning_to_home() }}</p>
  </div>
</template>
