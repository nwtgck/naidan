<script setup lang="ts">
import { ArrowLeftIcon, ArrowRightIcon, CpuIcon, MessageSquareIcon } from 'lucide-vue-next';
import type { messages as english } from '../../pages/endpoint-type-browser-provided-lm/messages/en';

defineProps<{ messages: typeof english }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="chrome-flow" data-docs-animation="chrome-model-flow" data-testid="chrome-model-flow" aria-hidden="true">
    <div class="chrome-flow-bar">
      <span class="chrome-flow-dots"><i /><i /><i /></span>
      <strong>{{ messages.chrome }}</strong>
      <span class="chrome-flow-device">{{ messages.on_this_device }}</span>
    </div>
    <div class="chrome-flow-content">
      <div class="chrome-flow-chat">
        <div class="chrome-flow-heading"><MessageSquareIcon :size="17" />{{ messages.naidan_chat }}</div>
        <div class="chrome-flow-message chrome-flow-question"><small>{{ messages.your_question }}</small><span class="chrome-flow-question-lines"><i /><i /></span></div>
        <div class="chrome-flow-message chrome-flow-answer">
          <small>{{ messages.answer }}</small>
          <span class="chrome-flow-answer-text"><i class="chrome-flow-chunk first" /><i class="chrome-flow-chunk second" /><i class="chrome-flow-chunk third" /></span>
        </div>
      </div>
      <div class="chrome-flow-transfer">
        <div class="chrome-flow-request"><span>{{ messages.question_request }}</span><ArrowRightIcon :size="19" /></div>
        <div class="chrome-flow-response"><ArrowLeftIcon :size="19" /><span>{{ messages.answer_response }}</span></div>
      </div>
      <div class="chrome-flow-model">
        <div class="chrome-flow-heading"><CpuIcon :size="17" />{{ messages.chrome_built_in_model }}</div>
        <span class="chrome-flow-provider">{{ messages.browser_provided_model_label }}</span>
        <div class="chrome-flow-signal"><i /><i /><i /></div>
        <p>{{ messages.on_device_processing }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chrome-flow { max-width:680px;margin-inline:auto;overflow:hidden;border:1px solid var(--line-strong);border-radius:15px;background:var(--surface);color:var(--text);box-shadow:var(--panel-shadow); }
.chrome-flow * { box-sizing:border-box; }
.chrome-flow-bar { display:flex;align-items:center;gap:12px;min-height:40px;padding:8px 14px;border-bottom:1px solid var(--line-strong);font-size:12px;line-height:1.4; }
.chrome-flow-bar strong { font-weight:800; }
.chrome-flow-dots { display:flex;gap:5px; }
.chrome-flow-dots i { width:7px;height:7px;border-radius:50%;background:var(--line-strong); }
.chrome-flow-device { margin-left:auto;color:var(--muted);font-size:11px; }
.chrome-flow-content { display:grid;grid-template-columns:minmax(0,1fr) 78px minmax(0,1fr);align-items:stretch;gap:11px;padding:16px; }
.chrome-flow-chat,.chrome-flow-model { min-width:0;padding:13px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-2); }
.chrome-flow-chat { display:grid;grid-template-rows:auto auto 1fr;gap:9px; }
.chrome-flow-heading { display:flex;align-items:center;gap:7px;min-width:0;color:var(--text);font-size:13px;line-height:1.4;font-weight:800;overflow-wrap:anywhere; }
.chrome-flow-heading svg { flex:none;color:var(--blue); }
.chrome-flow-message { min-width:0;padding:8px 10px;border:1px solid var(--line-strong);border-radius:9px;background:var(--surface);font-size:12px;line-height:1.5;overflow-wrap:anywhere; }
.chrome-flow-message small { display:block;margin-bottom:3px;color:var(--muted);font-size:10px;line-height:1.4;font-weight:750; }
.chrome-flow-question { opacity:0;animation:chrome-question 9s steps(1,end) infinite; }
.chrome-flow-question-lines,.chrome-flow-answer-text { display:grid;align-content:center;gap:6px;min-height:33px; }
.chrome-flow-question-lines i,.chrome-flow-chunk { display:block;height:7px;border-radius:999px;background:var(--line-strong); }
.chrome-flow-question-lines i:first-child { width:86%; }
.chrome-flow-question-lines i:last-child { width:58%; }
.chrome-flow-answer { border-color:color-mix(in srgb,var(--blue) 35%,var(--line-strong)); }
.chrome-flow-chunk { background:color-mix(in srgb,var(--blue) 43%,var(--line-strong));opacity:0; }
.chrome-flow-chunk.first { width:76%; }
.chrome-flow-chunk.second { width:90%; }
.chrome-flow-chunk.third { width:44%; }
.chrome-flow-chunk.first { animation:chrome-chunk-first 9s steps(1,end) infinite; }
.chrome-flow-chunk.second { animation:chrome-chunk-second 9s steps(1,end) infinite; }
.chrome-flow-chunk.third { animation:chrome-chunk-third 9s steps(1,end) infinite; }
.chrome-flow-transfer { display:flex;flex-direction:column;align-items:center;justify-content:center;gap:25px;min-width:0;color:var(--blue);font-size:10px;line-height:1.4;font-weight:750;text-align:center; }
.chrome-flow-request,.chrome-flow-response { display:flex;flex-direction:column;align-items:center;gap:4px;opacity:.45; }
.chrome-flow-request { animation:chrome-request 9s ease-in-out infinite; }
.chrome-flow-response { animation:chrome-response 9s ease-in-out infinite; }
.chrome-flow-model { display:flex;flex-direction:column;align-items:flex-start;gap:13px;animation:chrome-model-active 9s ease-in-out infinite; }
.chrome-flow-provider { max-width:100%;padding:5px 8px;border:1px solid color-mix(in srgb,var(--blue) 35%,var(--line-strong));border-radius:7px;color:var(--blue);font-size:10px;line-height:1.4;font-weight:750;overflow-wrap:anywhere; }
.chrome-flow-signal { display:flex;align-items:center;justify-content:center;gap:7px;width:100%;min-height:40px;border-radius:9px;background:var(--surface); }
.chrome-flow-signal i { width:7px;height:7px;border-radius:50%;background:var(--blue);opacity:.35;animation:chrome-signal 9s ease-in-out infinite; }
.chrome-flow-signal i:nth-child(2) { animation-delay:.13s; }
.chrome-flow-signal i:nth-child(3) { animation-delay:.26s; }
.chrome-flow-model p { margin:0;color:var(--muted);font-size:11px;line-height:1.5; }
@keyframes chrome-question { 0%,5% { opacity:0; } 8%,99% { opacity:1; } 100% { opacity:0; } }
@keyframes chrome-chunk-first { 0%,53% { opacity:0; } 56%,99% { opacity:1; } 100% { opacity:0; } }
@keyframes chrome-chunk-second { 0%,62% { opacity:0; } 65%,99% { opacity:1; } 100% { opacity:0; } }
@keyframes chrome-chunk-third { 0%,71% { opacity:0; } 74%,99% { opacity:1; } 100% { opacity:0; } }
@keyframes chrome-request { 0%,7%,35%,100% { opacity:.45;transform:none; } 14%,29% { opacity:1;transform:translateX(3px); } }
@keyframes chrome-response { 0%,50%,85%,100% { opacity:.45;transform:none; } 57%,78% { opacity:1;transform:translateX(-3px); } }
@keyframes chrome-model-active { 0%,22%,54%,100% { border-color:var(--line-strong);box-shadow:none; } 31%,47% { border-color:var(--blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 13%,transparent); } }
@keyframes chrome-signal { 0%,23%,51%,100% { opacity:.35;transform:none; } 31%,42% { opacity:1;transform:translateY(-3px); } }
html:has(#docs-pause-motion:checked) .chrome-flow .chrome-flow-question,
html:has(#docs-pause-motion:checked) .chrome-flow .chrome-flow-chunk { animation:none!important;opacity:1; }
html:has(#docs-pause-motion:checked) .chrome-flow .chrome-flow-request,
html:has(#docs-pause-motion:checked) .chrome-flow .chrome-flow-response,
html:has(#docs-pause-motion:checked) .chrome-flow .chrome-flow-model,
html:has(#docs-pause-motion:checked) .chrome-flow .chrome-flow-signal i { animation:none!important;transform:none; }
@media(max-width:650px) {
  .chrome-flow-content { grid-template-columns:minmax(0,1fr);gap:10px;padding:12px; }
  .chrome-flow-transfer { flex-direction:row;gap:32px; }
  .chrome-flow-request,.chrome-flow-response { gap:2px; }
  .chrome-flow-request svg { transform:rotate(90deg); }
  .chrome-flow-response svg { transform:rotate(90deg); }
  .chrome-flow-model { gap:9px; }
  .chrome-flow-signal { min-height:30px; }
}
@media(prefers-reduced-motion:reduce) {
  .chrome-flow-question,.chrome-flow-chunk { animation:none!important;opacity:1; }
  .chrome-flow-request,.chrome-flow-response,.chrome-flow-model,.chrome-flow-signal i { animation:none!important;transform:none; }
}
</style>
