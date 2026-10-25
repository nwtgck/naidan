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
  <pre data-testid="oss-license-text" tw-class="mt-4 p-4 bg-gray-50 dark:bg-black/20 rounded-xl text-[10px] font-mono text-gray-500 dark:text-gray-400 overflow-x-auto whitespace-pre-wrap leading-relaxed border border-gray-100/50 dark:border-gray-800/50">{{ licenseText }}</pre>
</template>
