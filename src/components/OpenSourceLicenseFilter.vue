<script setup lang="ts">
import { ref } from 'vue';
import { SearchIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

defineProps<{ disabled: boolean }>();
const query = defineModel<string>({ required: true });
const input = ref<HTMLInputElement>();

function clearFilter(): void {
  query.value = '';
  input.value?.focus();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div :tw-class="['flex min-w-0 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-900/40 dark:focus-within:border-blue-500', disabled && 'opacity-50']">
    <SearchIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
    <input
      ref="input"
      v-model="query"
      type="search"
      :aria-label="lazyStrings.OpenSourceLicenseFilter__filter_licenses()"
      :placeholder="lazyStrings.OpenSourceLicenseFilter__filter_by_name()"
      :disabled="disabled"
      autocomplete="off"
      :spellcheck="false"
      tw-class="min-h-10 min-w-0 flex-1 appearance-none bg-transparent py-2 text-sm text-gray-800 outline-none placeholder:text-gray-500 disabled:cursor-not-allowed dark:text-gray-100 dark:placeholder:text-gray-400 [&::-webkit-search-cancel-button]:hidden"
    />
    <button
      v-if="query.length > 0"
      type="button"
      :disabled="disabled"
      :aria-label="lazyStrings.OpenSourceLicenseFilter__clear_search()"
      data-testid="oss-license-filter-clear"
      tw-class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      @click="clearFilter"
    >
      <XIcon aria-hidden="true" tw-class="h-4 w-4" />
    </button>
  </div>
</template>
