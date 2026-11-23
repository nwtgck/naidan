<script setup lang="ts">
import TranslationWorkspace from '@/features/translation/components/TranslationWorkspace.vue';

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><TranslationWorkspace /></template>
