<script setup lang="ts">
// The parent owns drafts and the running workspace; this leaf supplies the location.
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><span hidden aria-hidden="true" /></template>
