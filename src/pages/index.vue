<script setup lang="ts">
import ChatArea from '../components/ChatArea.vue';


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <ChatArea />
</template>
