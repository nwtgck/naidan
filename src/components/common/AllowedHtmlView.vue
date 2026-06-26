<script setup lang="ts">
import type { AllowedHtml } from '@/lib/security/allowedHtml';

withDefaults(
  defineProps<{
    as?: 'span' | 'div' | 'pre' | 'code',
    html: AllowedHtml,
  }>(),
  {
    as: 'span',
  },
);

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <span v-if="as === 'span'" v-html="html"></span>
  <div v-else-if="as === 'div'" v-html="html"></div>
  <pre v-else-if="as === 'pre'" v-html="html"></pre>
  <code v-else v-html="html"></code>
</template>
