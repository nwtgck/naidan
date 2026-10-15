<script setup lang="ts">
defineProps<{ href?: never }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <a href="#docs-main"><slot /></a>
</template>
