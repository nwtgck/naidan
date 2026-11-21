<script setup lang="ts">
// The parent keeps the editor and selected file when switching input sources.
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><span hidden aria-hidden="true" /></template>
