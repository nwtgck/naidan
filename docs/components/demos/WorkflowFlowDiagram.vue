<script setup lang="ts">
import { ArrowRightIcon, FileTextIcon, ListIcon, MessageSquareTextIcon } from 'lucide-vue-next';
import type { WorkflowGuideMessages } from '../../messages/types';

defineProps<{ messages: WorkflowGuideMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="workflow-flow" data-docs-animation="workflow-flow" role="img" :aria-label="messages.flow_label">
    <div class="flow-step input"><FileTextIcon :size="20" aria-hidden="true" /><strong>{{ messages.input_name }}</strong><p>{{ messages.notes_example }}</p><code>value</code></div>
    <ArrowRightIcon class="flow-arrow first" :size="24" aria-hidden="true" />
    <div class="flow-step summary"><ListIcon :size="20" aria-hidden="true" /><strong>{{ messages.summary_name }}</strong><p>{{ messages.summary_example }}</p><code>text</code></div>
    <ArrowRightIcon class="flow-arrow second" :size="24" aria-hidden="true" />
    <div class="flow-step share"><MessageSquareTextIcon :size="20" aria-hidden="true" /><strong>{{ messages.share_name }}</strong><p>{{ messages.share_example }}</p><code>text</code></div>
  </div>
</template>

<style scoped>
.workflow-flow {
  display: grid;
  grid-template-columns: minmax(0,1fr) 24px minmax(0,1fr) 24px minmax(0,1fr);
  gap: 10px;
  align-items: center;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--surface);
}
.flow-step {
  display: grid;
  grid-template-columns: 22px minmax(0,1fr);
  gap: 10px;
  align-content: start;
  min-height: 240px;
  padding: 15px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--bg);
}
.flow-step > svg {
  color: var(--blue);
}
.flow-step strong {
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.flow-step p {
  grid-column: 1/-1;
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.flow-step code {
  grid-column: 1/-1;
  align-self: end;
  justify-self: start;
  color: var(--muted);
  font-size: 10px;
}
.flow-arrow {
  color: var(--blue);
  animation: workflow-transfer 12s ease-in-out infinite;
}
.flow-arrow.second {
  animation-delay: 4s;
}
.flow-step.summary {
  animation: workflow-summary 12s ease-in-out infinite;
}
.flow-step.share {
  animation: workflow-share 12s ease-in-out infinite;
}
@keyframes workflow-transfer {
  0%,10%,55%,100% {
    opacity: .3;
    transform: translateX(-3px);
  }
  20%,40% {
    opacity: 1;
    transform: translateX(3px);
  }
}
@keyframes workflow-summary {
  0%,20%,100% {
    border-color: var(--line-strong);
  }
  30%,80% {
    border-color: var(--blue);
  }
}
@keyframes workflow-share {
  0%,50%,100% {
    border-color: var(--line-strong);
  }
  60%,90% {
    border-color: var(--blue);
  }
}
html:has(#docs-pause-motion:checked) .workflow-flow * {
  animation: none !important;
}
html:has(#docs-pause-motion:checked) .workflow-flow .flow-arrow {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .workflow-flow * {
    animation: none !important;
  }
  .workflow-flow .flow-arrow {
    opacity: 1;
    transform: none;
  }
}
@media (max-width: 650px) {
  .workflow-flow {
    grid-template-columns: minmax(0,1fr);
    gap: 9px;
    padding: 14px;
  }
  .flow-step {
    min-height: 0;
    padding: 12px;
  }
  .flow-step p {
    line-height: 1.65;
  }
  .flow-arrow {
    justify-self: center;
    rotate: 90deg;
  }
}
</style>
