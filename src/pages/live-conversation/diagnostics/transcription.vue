<script setup lang="ts">
// The Live Conversation parent retains the model, source file and results.
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><span hidden aria-hidden="true" /></template>
