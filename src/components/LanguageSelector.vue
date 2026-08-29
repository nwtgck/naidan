<script setup lang="ts">
import { computed, ref } from 'vue';
import { GlobeIcon, ChevronDownIcon, CheckIcon } from 'lucide-vue-next';
import {
  currentLocale,
  lazyStrings,
  type UiLocale,
} from '@/strings';
import { useSettings } from '@/composables/useSettings';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { resolveStandalonePackageLocale } from '@/features/file-protocol-standalone/logic/package-locale';

const settingsStore = useSettings();
const packageLocale = resolveStandalonePackageLocale();
const isOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

const isChangingLocale = ref(false);
// This is an action capability, not a state model: package constraints and an
// in-flight locale change both make the same user action unavailable.
const canChangeLocale = computed(() => packageLocale === undefined && !isChangingLocale.value);
const selectedLocale = computed<UiLocale>(() => packageLocale ?? currentLocale.value);

// Keep locale names self-identifying. If users accidentally switch to a
// language they cannot read, these fixed labels still show how to return.
const languageLabels: Record<UiLocale, string> = {
  en: 'English',
  ja: '日本語',
  'zh-Hans': '简体中文',
  'pt-BR': 'Português (Brasil)',
  es: 'Español',
  ko: '한국어',
  de: 'Deutsch',
};

const languages = (Object.entries(languageLabels) as [UiLocale, string][])
  .map(([value, label]) => ({ value, label }))
  // Plain string comparison intentionally keeps the order independent of the
  // browser and active locale.
  .toSorted((left, right) => {
    if (left.label < right.label) return -1;
    if (left.label > right.label) return 1;
    return 0;
  });

const currentLanguageLabel = computed(() => {
  return languages.find(lang => lang.value === selectedLocale.value)?.label ?? 'English';
});

async function changeLocale({ locale }: {
  locale: UiLocale;
}): Promise<void> {
  if (!canChangeLocale.value) return;

  isChangingLocale.value = true;
  try {
    await settingsStore.setLocale({ locale });
    isOpen.value = false;
  } finally {
    isChangingLocale.value = false;
  }
}

function selectLanguage({ locale }: { locale: UiLocale }) {
  void changeLocale({ locale }).catch((error: unknown) => {
    console.error('Failed to change locale:', error);
  });
}

function toggleDropdown() {
  if (isChangingLocale.value) return;
  isOpen.value = !isOpen.value;
}

function handleClickOutside({ event }: { event: MouseEvent }) {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
}

useEventTargetListener(document, 'mousedown', (event) => handleClickOutside({ event }));

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      changeLocale,
    },
  }) || {}),
});
</script>

<template>
  <div ref="dropdownRef" tw-class="relative inline-block text-left" data-testid="language-selector">
    <button
      type="button"
      :disabled="isChangingLocale"
      tw-class="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-bold text-gray-700 transition-all hover:border-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 hover:bg-gray-50/50 dark:hover:bg-gray-800/80 active:scale-95 disabled:opacity-50 select-none shadow-sm"
      @click="toggleDropdown"
      :aria-label="lazyStrings.LanguageSelector__language()"
      data-testid="language-selector-toggle"
    >
      <GlobeIcon tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
      <span tw-class="max-w-[70px] truncate leading-none">{{ currentLanguageLabel }}</span>
      <ChevronDownIcon :tw-class="['h-3 w-3 text-gray-400 dark:text-gray-500 transition-transform duration-200', { 'rotate-180': isOpen }]" />
    </button>

    <Transition name="dropdown">
      <div
        v-if="isOpen"
        tw-class="absolute right-0 mt-1.5 w-36 origin-top-right rounded-xl border border-gray-100 bg-white p-1 shadow-lg dark:border-gray-800 dark:bg-gray-900 z-50"
      >
        <div tw-class="space-y-0.5" role="menu">
          <button
            v-for="lang in languages"
            :key="lang.value"
            type="button"
            :disabled="!canChangeLocale"
            :tw-class="['flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50', selectedLocale === lang.value
              ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
              : canChangeLocale
                ? 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                : 'text-gray-600 dark:text-gray-300']"
            role="menuitem"
            data-testid="language-selector-option"
            @click="selectLanguage({ locale: lang.value })"
          >
            <span>{{ lang.label }}</span>
            <CheckIcon v-if="selectedLocale === lang.value" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 100ms ease, transform 100ms ease;
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(-4px);
}
</style>
