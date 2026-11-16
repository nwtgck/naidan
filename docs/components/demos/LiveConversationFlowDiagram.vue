<script setup lang="ts">
import { ArrowRightIcon, AudioLinesIcon, CpuIcon, MicIcon } from 'lucide-vue-next';
import type { LiveConversationGuideMessages } from '../../messages/types';

defineProps<{ messages: LiveConversationGuideMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="local-flow" role="img" :aria-label="messages.local_flow_label" data-testid="live-local-flow">
    <p>{{ messages.local_flow_note }}</p>
    <div class="flow-items" aria-hidden="true">
      <div class="flow-item"><MicIcon :size="23" /><strong>{{ messages.input_flow }}</strong></div>
      <ArrowRightIcon class="flow-arrow" :size="20" />
      <div class="flow-item model"><CpuIcon :size="26" /><strong>{{ messages.local_model_flow }}</strong><small>LFM3 Audio / Omni</small></div>
      <ArrowRightIcon class="flow-arrow" :size="20" />
      <div class="flow-item"><AudioLinesIcon :size="23" /><strong>{{ messages.output_flow }}</strong></div>
    </div>
  </div>
</template>

<style scoped>
.local-flow {
  padding: 22px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  font: 13px/1.55 ui-sans-serif, system-ui, sans-serif;
}
.local-flow p {
  margin: 0 0 17px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
.flow-items {
  display: grid;
  grid-template-columns: minmax(0,1fr) 20px minmax(0,1.2fr) 20px minmax(0,1fr);
  align-items: center;
  gap: 12px;
}
.flow-item {
  display: grid;
  justify-items: center;
  gap: 10px;
  min-width: 0;
  padding: 16px 8px;
  text-align: center;
  overflow-wrap: anywhere;
}
.flow-item svg,.flow-arrow {
  color: var(--blue);
}
.model {
  border: 1px solid color-mix(in srgb,var(--blue) 35%,var(--line));
  border-radius: 12px;
  background: color-mix(in srgb,var(--blue) 6%,var(--surface));
}
.model small {
  color: var(--muted);
  font-size: 11px;
}
@media(max-width:560px) {
  .local-flow {
    padding: 16px 12px;
  }
  .flow-items {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .flow-item {
    width: 100%;
    grid-template-columns: 28px minmax(0,1fr);
    padding: 12px;
    text-align: left;
  }
  .model small {
    grid-column: 2;
    justify-self: start;
  }
  .flow-item strong {
    justify-self: start;
  }
  .flow-arrow {
    justify-self: center;
    transform: rotate(90deg);
  }
}
</style>
