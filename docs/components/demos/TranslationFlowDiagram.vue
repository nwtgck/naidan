<script setup lang="ts">
import { ArrowRightIcon, BrainCircuitIcon, LanguagesIcon } from 'lucide-vue-next';
import HomeBrowserFrame from './HomeBrowserFrame.vue';
import type { TranslationGuideMessages } from '../../messages/types';

defineProps<{ messages: TranslationGuideMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="translation-flow" data-docs-animation="translation-flow" data-testid="translation-flow" aria-hidden="true">
    <HomeBrowserFrame identity="naidan" :tab-label="messages.naidan">
      <div class="flow-content"><div class="flow-location"><LanguagesIcon :size="15" />{{ messages.on_this_device }}</div><div class="flow-nodes"><div class="text-node"><small>{{ messages.source_text }}</small><p lang="en">{{ messages.sample_source }}</p></div><ArrowRightIcon class="flow-arrow" :size="19" /><div class="model-node"><BrainCircuitIcon :size="28" /><strong>{{ messages.browser_model }}</strong></div><ArrowRightIcon class="flow-arrow" :size="19" /><div class="text-node result-node"><small>{{ messages.translated_text }}</small><p lang="ja">{{ messages.sample_translation }}</p></div></div></div>
    </HomeBrowserFrame>
  </div>
</template>

<style scoped>
.translation-flow {
  max-width: 720px;
  margin-inline: auto;
}
.flow-content {
  padding: 20px;
  background: var(--surface);
}
.flow-location {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-bottom: 18px;
  color: var(--blue);
  font: 600 12px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.flow-nodes {
  display: grid;
  grid-template-columns: minmax(0,1fr) 19px 140px 19px minmax(0,1fr);
  align-items: center;
  gap: 12px;
}
.text-node {
  align-self: stretch;
  padding: 13px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface-2);
}
.text-node small {
  color: var(--muted);
  font: 600 11px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.text-node p {
  margin: 8px 0 0;
  color: var(--text);
  font: 13px/1.8 ui-sans-serif,system-ui,sans-serif;
  overflow-wrap: anywhere;
}
.model-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 11px;
  min-height: 112px;
  padding: 12px;
  border: 1px solid color-mix(in srgb,var(--blue) 35%,var(--line));
  border-radius: 14px;
  background: color-mix(in srgb,var(--blue) 6%,var(--surface));
  color: var(--blue);
  text-align: center;
  animation: translation-model-pulse 8s ease infinite;
}
.model-node strong {
  font: 600 12px/1.6 ui-sans-serif,system-ui,sans-serif;
}
.flow-arrow {
  color: var(--muted);
}
.result-node {
  animation: translation-result-focus 8s ease infinite;
}
@keyframes translation-model-pulse {
  0%,18%,65%,100% {
    box-shadow: 0 0 0 0 transparent;
  }
  28%,48% {
    box-shadow: 0 0 0 5px color-mix(in srgb,var(--blue) 12%,transparent);
  }
}
@keyframes translation-result-focus {
  0%,45%,100% {
    border-color: var(--line-strong);
  }
  60%,86% {
    border-color: var(--blue);
  }
}
html:has(#docs-pause-motion:checked) .translation-flow .model-node,
html:has(#docs-pause-motion:checked) .translation-flow .result-node {
  animation: none!important;
}
@media(prefers-reduced-motion:reduce) {
  .model-node,.result-node {
    animation: none!important;
  }
}
@media(max-width:560px) {
  .flow-content {
    padding: 16px;
  }
  .flow-location {
    margin-bottom: 14px;
  }
  .flow-nodes {
    grid-template-columns: 1fr;
    gap: 9px;
  }
  .flow-arrow {
    justify-self: center;
    transform: rotate(90deg);
  }
  .text-node {
    padding: 11px 13px;
  }
  .text-node p {
    margin-top: 4px;
  }
  .model-node {
    flex-direction: row;
    min-height: 64px;
    gap: 12px;
  }
}
</style>
