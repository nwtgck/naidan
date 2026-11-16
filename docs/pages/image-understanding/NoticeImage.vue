<script setup lang="ts">
import type { ImageUnderstandingGuideMessages } from '../../messages/types';

defineProps<{ messages: ImageUnderstandingGuideMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <svg class="notice-image" viewBox="0 0 360 244" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" data-testid="image-understanding-notice">
    <rect width="360" height="244" rx="8" fill="#f4f7fc" />
    <rect x="18" y="16" width="324" height="212" rx="6" fill="white" stroke="#cbd5e1" />
    <rect x="18" y="16" width="324" height="44" rx="6" fill="#1d4ed8" />
    <text x="36" y="45" fill="white" font-size="21" font-weight="700">{{ messages.notice_title }}</text>
    <g fill="#172554" font-size="16">
      <text x="36" y="89" font-weight="700">{{ messages.notice_first_event }}</text>
      <text x="36" y="112">{{ messages.notice_first_time }}</text>
      <text x="36" y="135">{{ messages.notice_first_place }}</text>
      <path d="M36 150H324" stroke="#dbe3ef" />
      <text x="36" y="175" font-weight="700">{{ messages.notice_second_event }}</text>
      <text x="36" y="198">{{ messages.notice_second_time }}</text>
      <text x="36" y="221">{{ messages.notice_second_place }}</text>
    </g>
  </svg>
</template>

<style scoped>
.notice-image {
  display: block;
  width: 100%;
  height: auto;
  font-family: ui-sans-serif,system-ui,sans-serif;
}
</style>
