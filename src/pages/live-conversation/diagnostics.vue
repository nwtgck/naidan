<script setup lang="ts">
import { RouterView } from 'vue-router';
// The parent owns the model and the retained input. This leaf is a location.
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><span hidden aria-hidden="true" /><RouterView /></template>
