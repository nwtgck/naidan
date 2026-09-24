<script setup lang="ts">
import AudioGenerationView from '@/features/audio-generation/AudioGenerationView.vue';
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <AudioGenerationView />
</template>
