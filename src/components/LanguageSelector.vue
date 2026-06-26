<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  currentLocale,
  lazyStrings,
  type UiLocale,
} from '@/strings';
import { useSettings } from '@/composables/useSettings';

const settingsStore = useSettings();

const isChangingLocale = ref(false);
const selectedLocale = computed({
  get: () => currentLocale.value,
  set: (locale: UiLocale) => {
    void changeLocale({ locale }).catch((error: unknown) => {
      console.error('Failed to change locale:', error);
    });
  },
});

async function changeLocale({ locale }: {
  locale: UiLocale;
}): Promise<void> {
  isChangingLocale.value = true;
  try {
    await settingsStore.setLocale({ locale });
  } finally {
    isChangingLocale.value = false;
  }
}

defineExpose({
  TEST_ONLY: {
    changeLocale,
  },
});
</script>

<template>
  <label class="flex min-w-0 flex-1 items-center gap-2 text-[10px] font-bold text-gray-500 dark:text-gray-400">
    <span class="sr-only">{{ lazyStrings.LanguageSelector__language() }}</span>
    <select
      v-model="selectedLocale"
      :disabled="isChangingLocale"
      class="min-w-0 w-full rounded-xl border border-gray-200 bg-white px-2 py-2 text-[10px] font-bold text-gray-700 outline-none transition-colors hover:border-blue-300 focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
      data-testid="language-selector"
      :aria-label="lazyStrings.LanguageSelector__language()"
    >
      <!-- Keep locale names self-identifying. If users accidentally switch to a
           language they cannot read, these fixed labels still show how to return. -->
      <option value="en">English</option>
      <option value="ja">日本語</option>
    </select>
  </label>
</template>
