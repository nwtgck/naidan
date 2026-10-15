<script setup lang="ts">
import { computed } from 'vue';
import { BirdIcon, UserIcon, PaperclipIcon, SendIcon, SquareIcon, ChevronDownIcon, CopyIcon, PencilIcon, RefreshCwIcon, MoreHorizontalIcon, MoreVerticalIcon, Volume2Icon, Settings2Icon, FileEditIcon } from 'lucide-vue-next';
import NaidanAppFrame from './demos/NaidanAppFrame.vue';
import type { CommonMessages } from '../messages/types';

const props = defineProps<{ messages: typeof import('../pages/index/messages/en').messages; common: CommonMessages }>();

// Locale-authored chunks remain in static HTML and are revealed in reading order.
const introChunks = computed(() => props.messages.plan_intro_chunks().map((text, index) => ({ text, index })));
const itemChunks = computed(() => {
  let nextIndex = introChunks.value.length;
  return props.messages.plan_item_chunks().map(chunks => {
    const startIndex = nextIndex;
    return {
      startIndex,
      chunks: chunks.map(text => {
        const index = nextIndex;
        nextIndex += 1;
        return { text, index };
      }),
    };
  });
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div class="home-demonstration" data-docs-animation="chat-response" aria-hidden="true">
    <NaidanAppFrame :messages="common" :title="messages.project_summary" address="Naidan" sidebar="visible">
      <div class="demo-scene" data-testid="docs-home-chat-scene">
        <div class="demo-thread">
          <div class="demo-message demo-user">
            <div class="demo-message-header"><span class="demo-avatar"><UserIcon :size="13" /></span><b class="demo-user-role">{{ messages.you }}</b></div>
            <p data-testid="docs-home-prompt">{{ messages.plan_for_tomorrow_prompt }}</p>
            <div class="demo-message-actions"><MoreHorizontalIcon :size="12" /><Volume2Icon :size="12" /><SendIcon :size="12" /><CopyIcon :size="12" /><PencilIcon :size="12" /><MoreVerticalIcon :size="12" /></div>
          </div>
          <div class="demo-message demo-assistant">
            <div class="demo-message-header"><span class="demo-avatar demo-avatar-assistant"><BirdIcon :size="13" /></span><b>Gemma</b><span class="demo-header-tools"><Volume2Icon :size="11" /><span class="demo-generating-control"><SquareIcon :size="10" /></span><MoreHorizontalIcon :size="12" /></span></div>
            <div class="demo-answer" data-testid="docs-home-response">
              <p data-testid="docs-home-response-intro"><span v-for="chunk in introChunks" :key="chunk.index" class="demo-chunk" :class="`demo-chunk-${chunk.index}`" :data-chunk-index="chunk.index" data-testid="docs-home-response-chunk">{{ chunk.text }}</span></p>
              <ul>
                <li v-for="(item, itemIndex) in itemChunks" :key="itemIndex" class="demo-item" :class="`demo-item-${item.startIndex}`" data-testid="docs-home-response-item"><span v-for="chunk in item.chunks" :key="chunk.index" class="demo-chunk" :class="`demo-chunk-${chunk.index}`" :data-chunk-index="chunk.index" data-testid="docs-home-response-chunk">{{ chunk.text }}</span></li>
              </ul>
            </div>
            <div class="demo-message-actions"><MoreHorizontalIcon :size="12" /><Volume2Icon :size="12" /><RefreshCwIcon :size="12" /><CopyIcon :size="12" /><PencilIcon :size="12" /><MoreVerticalIcon :size="12" /></div>
          </div>
        </div>
        <div class="demo-input"><div class="demo-placeholder">{{ messages.type_a_message }}</div><div class="demo-input-editor"><ChevronDownIcon :size="11" /><FileEditIcon :size="11" /></div><div class="demo-input-controls"><span class="demo-model">Gemma <ChevronDownIcon :size="10" /></span><PaperclipIcon :size="13" /><Settings2Icon :size="13" /><span class="demo-send"><span class="demo-send-ready"><SendIcon :size="13" /></span><span class="demo-send-stop"><span>Esc</span><SquareIcon :size="11" /></span></span></div></div>
      </div>
    </NaidanAppFrame>
    <div class="demo-capabilities"><span v-for="capability in messages.generation_capabilities()" :key="capability">{{ capability }}</span></div>
  </div>
</template>

<style scoped>
.home-demonstration { min-width: 0; }
.demo-scene { display: flex; flex-direction: column; font: 11px/1.7 ui-sans-serif,system-ui,sans-serif; }
.demo-thread { flex: 1; min-width: 0; }
.demo-message { padding: 16px 19px 13px; }
.demo-assistant { background: #1f293733; border-block: 1px solid #1f293780; }
.demo-message-header { display: flex; align-items: center; gap: 9px; height: 25px; color: #9ca3af; font-size: 10px; font-weight: 700; }
.demo-message-header b { font-size: 10px; font-weight: 700; }
.demo-user-role { color: #e5e7eb; text-transform: uppercase; letter-spacing: .1em; }
.demo-avatar { display: inline-flex; align-items: center; justify-content: center; width: 25px; height: 25px; flex: none; background: #1f2937; border: 1px solid #374151; border-radius: 8px; color: #9ca3af; }
.demo-avatar-assistant { color: #60a5fa; }
.demo-header-tools { display: inline-flex; align-items: center; gap: 8px; color: #9ca3af; }
.demo-user p,.demo-answer p { margin: 5px 0 0; color: #e5e7eb; }
.demo-message-actions { display: flex; align-items: center; justify-content: flex-end; gap: 11px; margin-top: 8px; color: #9ca3af; }
.demo-message-actions svg:first-child { color: #60a5fa66; }
.demo-answer { color: #d1d5db; animation: docs-response-cycle 12s linear infinite both; }
.demo-answer ul { margin: 3px 0 0; padding-left: 17px; }
.demo-answer li { padding: 0; }
.demo-chunk,.demo-item { animation-duration: 12s; animation-timing-function: steps(1,end); animation-iteration-count: infinite; animation-fill-mode: both; }
.demo-chunk-0 { animation-name: docs-chunk-0; }
.demo-chunk-1 { animation-name: docs-chunk-1; }
.demo-chunk-2 { animation-name: docs-chunk-2; }
.demo-chunk-3 { animation-name: docs-chunk-3; }
.demo-chunk-4,.demo-item-4 { animation-name: docs-chunk-4; }
.demo-chunk-5 { animation-name: docs-chunk-5; }
.demo-chunk-6 { animation-name: docs-chunk-6; }
.demo-chunk-7,.demo-item-7 { animation-name: docs-chunk-7; }
.demo-chunk-8 { animation-name: docs-chunk-8; }
.demo-chunk-9 { animation-name: docs-chunk-9; }
.demo-chunk-10 { animation-name: docs-chunk-10; }
.demo-chunk-11,.demo-item-11 { animation-name: docs-chunk-11; }
.demo-chunk-12 { animation-name: docs-chunk-12; }
.demo-chunk-13 { animation-name: docs-chunk-13; }
.demo-chunk-14 { animation-name: docs-chunk-14; }
.demo-generating-control,.demo-send-stop { animation: docs-generating 12s steps(1,end) infinite both; }
.demo-send-ready { animation: docs-send-disabled 12s steps(1,end) infinite both; }
.demo-input { position: relative; background: #1f2937; border: 1px solid #374151; border-radius: 12px; margin: 9px 12px 14px; padding: 12px; box-shadow: 0 6px 18px #0003; }
.demo-placeholder { color: #8492a6; font: 10px/1.6 ui-sans-serif,system-ui,sans-serif; padding-bottom: 14px; }
.demo-input-editor { position: absolute; top: 10px; right: 12px; display: flex; flex-direction: column; gap: 5px; color: #9ca3af; }
.demo-input-controls { display: flex; align-items: center; gap: 10px; color: #a3b2c9; }
.demo-model { display: flex; align-items: center; gap: 5px; font-size: 9px; margin-right: auto; }
.demo-send { display: grid; align-items: center; justify-items: center; min-width: 39px; min-height: 28px; background: #2563eb; color: white; border-radius: 8px; box-shadow: 0 3px 9px #2563eb4d; }
.demo-send-ready,.demo-send-stop { grid-area: 1 / 1; display: inline-flex; align-items: center; gap: 4px; padding: 0 5px; }
.demo-send-ready { opacity: .5; }
.demo-send-stop { font-size: 8px; }
.demo-capabilities { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; font: 10px/1.4 ui-sans-serif,system-ui,sans-serif; color: var(--muted); }
.demo-capabilities span { border: 1px solid var(--line-strong); border-radius: 6px; padding: 5px 8px; }

/* The entire response fades together before replay. The chunks only appear;
   completed lines never disappear in reverse reading order. */
@keyframes docs-response-cycle { 0%,6% { opacity: 0; } 8%,92% { opacity: 1; } 98%,100% { opacity: 0; } }
@keyframes docs-chunk-0 { 0%,11.9% { visibility: hidden; } 12%,100% { visibility: visible; } }
@keyframes docs-chunk-1 { 0%,13.9% { visibility: hidden; } 14%,100% { visibility: visible; } }
@keyframes docs-chunk-2 { 0%,15.9% { visibility: hidden; } 16%,100% { visibility: visible; } }
@keyframes docs-chunk-3 { 0%,17.9% { visibility: hidden; } 18%,100% { visibility: visible; } }
@keyframes docs-chunk-4 { 0%,19.9% { visibility: hidden; } 20%,100% { visibility: visible; } }
@keyframes docs-chunk-5 { 0%,21.9% { visibility: hidden; } 22%,100% { visibility: visible; } }
@keyframes docs-chunk-6 { 0%,23.9% { visibility: hidden; } 24%,100% { visibility: visible; } }
@keyframes docs-chunk-7 { 0%,25.9% { visibility: hidden; } 26%,100% { visibility: visible; } }
@keyframes docs-chunk-8 { 0%,27.9% { visibility: hidden; } 28%,100% { visibility: visible; } }
@keyframes docs-chunk-9 { 0%,29.9% { visibility: hidden; } 30%,100% { visibility: visible; } }
@keyframes docs-chunk-10 { 0%,31.9% { visibility: hidden; } 32%,100% { visibility: visible; } }
@keyframes docs-chunk-11 { 0%,33.9% { visibility: hidden; } 34%,100% { visibility: visible; } }
@keyframes docs-chunk-12 { 0%,35.9% { visibility: hidden; } 36%,100% { visibility: visible; } }
@keyframes docs-chunk-13 { 0%,37.9% { visibility: hidden; } 38%,100% { visibility: visible; } }
@keyframes docs-chunk-14 { 0%,39.9% { visibility: hidden; } 40%,100% { visibility: visible; } }
@keyframes docs-generating { 0%,7.9%,42%,100% { visibility: hidden; } 8%,41.9% { visibility: visible; } }
@keyframes docs-send-disabled { 0%,7.9%,42%,100% { visibility: visible; } 8%,41.9% { visibility: hidden; } }

html:has(#docs-pause-motion:checked) .demo-answer,
html:has(#docs-pause-motion:checked) .demo-chunk,
html:has(#docs-pause-motion:checked) .demo-item { animation: none !important; opacity: 1 !important; visibility: visible !important; }
html:has(#docs-pause-motion:checked) .demo-send-ready { animation: none !important; visibility: visible !important; }
html:has(#docs-pause-motion:checked) .demo-generating-control,
html:has(#docs-pause-motion:checked) .demo-send-stop { animation: none !important; visibility: hidden !important; }
@media (prefers-reduced-motion: reduce) {
  .demo-answer,.demo-chunk,.demo-item { animation: none !important; opacity: 1 !important; visibility: visible !important; }
  .demo-send-ready { animation: none !important; visibility: visible !important; }
  .demo-generating-control,.demo-send-stop { animation: none !important; visibility: hidden !important; }
}
@media (max-width: 600px) {
  .demo-scene { font-size: 9px; }
  .demo-message { padding: 12px 10px; }
  .demo-message-actions { gap: 8px; }
  .demo-input { padding: 9px; margin: 6px 9px 12px; }
}
</style>
