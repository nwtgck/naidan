<script setup lang="ts">
import ImageGenerationLab from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationLab.vue';
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><ImageGenerationLab /></template>
