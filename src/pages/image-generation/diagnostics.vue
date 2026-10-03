<script setup lang="ts">
// The parent owns the image runtime. This leaf supplies only the location.
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><span hidden aria-hidden="true" /></template>
