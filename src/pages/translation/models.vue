<script setup lang="ts">
// The parent owns the workspace so opening models never discards the draft.
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><span hidden /></template>
