<script setup lang="ts">
import LiveConversationView from '@/features/live-conversation/components/LiveConversationView.vue';
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <LiveConversationView />
</template>
