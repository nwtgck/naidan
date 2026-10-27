<script setup lang="ts">
import { onBeforeUnmount, shallowRef, watch } from 'vue';
import type { NaidanLicenseCatalog } from '@/01-models/naidan-license';

const props = defineProps<{
  index: number,
  readLicenseText: NaidanLicenseCatalog['readLicenseText'],
}>();

// Only an expanded body owns this string. Never cache it in a parent, module,
// computed value, or per-license closure that outlives the visible body.
const licenseText = shallowRef<string | null>();
watch([() => props.index, () => props.readLicenseText], ([index, readLicenseText]) => {
  licenseText.value = readLicenseText({ index });
}, { immediate: true });
onBeforeUnmount(() => {
  licenseText.value = undefined;
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      licenseText,
    },
  }) || {}),
});
</script>

<template>
  <pre data-testid="oss-license-text" tw-class="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200/70 bg-gray-50/80 p-3 font-mono text-xs leading-relaxed text-gray-600 dark:border-gray-800 dark:bg-gray-950/35 dark:text-gray-300">{{ licenseText }}</pre>
</template>
