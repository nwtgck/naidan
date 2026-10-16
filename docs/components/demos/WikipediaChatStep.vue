<script setup lang="ts">
import { CheckCircle2Icon, HammerIcon, SendIcon } from 'lucide-vue-next';

defineProps<{ stage: 'search' | 'page' | 'result'; messages: typeof import('../../pages/tool-wikipedia/messages/en').messages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="wiki-chat-scene" :class="`stage-${stage}`" :data-docs-animation="`wikipedia-chat-${stage}`" :data-testid="`wikipedia-chat-${stage}`" aria-hidden="true">
    <div class="chat-header">{{ messages.sample_chat_title }}</div>
    <div class="conversation">
      <div class="user-message">{{ messages.aurora_question }}</div>
      <div class="tool-call"><HammerIcon v-if="stage === 'search'" :size="15" /><CheckCircle2Icon v-else :size="15" /><strong>{{ messages.search_tool_call }}</strong></div>
      <div v-if="stage !== 'search'" class="tool-result"><small>{{ messages.tool_result_label }}</small><span>{{ messages.aurora_search_result }}</span></div>
      <template v-if="stage === 'result'">
        <div class="tool-call page-tool"><CheckCircle2Icon :size="15" /><strong>{{ messages.page_tool_call }}</strong></div>
        <div class="assistant-message">{{ messages.aurora_answer }}</div>
      </template>
    </div>
    <div class="composer"><span>{{ messages.message_placeholder }}</span><i><SendIcon :size="14" /></i></div>
    <div v-if="stage !== 'result'" class="approval-panel">
      <strong>{{ stage === 'search' ? messages.search_approval_action : messages.page_approval_action }}</strong>
      <div class="approval-preview">
        <template v-if="stage === 'search'"><span>{{ messages.keyword_label }}</span> {{ messages.aurora_search_term }}</template>
        <template v-else><b>{{ messages.aurora_page_title }}</b><small>{{ messages.aurora_page_id }}</small></template>
      </div>
      <div class="approval-options"><span>{{ messages.allow_once }}</span><span>{{ messages.allow_for_chat }} <small>{{ stage === 'search' ? messages.search_approval_label : messages.page_approval_label }}</small></span><span>{{ messages.allow_globally }} <small>{{ stage === 'search' ? messages.search_approval_label : messages.page_approval_label }}</small></span><span>{{ messages.deny_action }}</span></div>
    </div>
  </div>
</template>

<style scoped>
.wiki-chat-scene{position:relative;display:flex;flex-direction:column;height:540px;max-width:680px;margin-inline:auto;overflow:hidden;border:1px solid var(--line-strong);border-radius:14px;background:#111827;color:#e5e7eb;font:12px/1.5 ui-sans-serif,system-ui,sans-serif;box-shadow:var(--panel-shadow)}.stage-result{height:470px}
.chat-header{flex:none;padding:13px 17px;border-bottom:1px solid #303d50;font-weight:750;font-size:12px}.conversation{min-height:0;flex:1;overflow:hidden;padding:17px 19px}.user-message{max-width:80%;margin:0 0 15px auto;padding:10px 12px;border:1px solid #46556b;border-radius:10px;background:#25334a;color:#f1f5f9;overflow-wrap:anywhere;animation:user-arrive 8s linear infinite}.tool-call{display:flex;align-items:center;gap:8px;width:max-content;max-width:100%;min-width:190px;padding:7px 9px;border:1px solid #364457;border-radius:9px;background:#202d40;color:#b8c8dc;animation:tool-arrive 8s linear infinite}.tool-call svg{color:#7bb6ff;flex:none}.tool-call strong{font:11px ui-monospace,monospace;overflow-wrap:anywhere}.tool-result{width:max-content;max-width:100%;margin:4px 0 11px;padding:8px 10px;border:1px solid #364457;border-radius:7px;background:#1b2738;color:#a9d8b8;font:10px/1.5 ui-monospace,monospace;animation:result-arrive 8s linear infinite}.tool-result small{display:block;color:#94a3b8;font:9px ui-sans-serif,system-ui,sans-serif;text-transform:uppercase}.page-tool{margin-top:8px}.assistant-message{max-width:78%;margin:10px 0;padding:10px 12px;border:1px solid #364457;border-radius:10px;background:#1b2738;color:#e2e8f0;overflow-wrap:anywhere;animation:answer-arrive 8s linear infinite}.composer{display:flex;align-items:center;justify-content:space-between;flex:none;margin:0 17px 12px;padding:9px 11px;border:1px solid #39455a;border-radius:10px;background:#1f2937;color:#8b99ae;font-size:10px}.composer i{display:grid;place-items:center;width:26px;height:25px;border-radius:6px;background:#2563eb;color:#fff;font-style:normal}
.approval-panel{position:absolute;left:17px;right:17px;bottom:58px;padding:12px;border:1px solid #475569;border-radius:13px;background:#263345;box-shadow:0 15px 40px #000a;animation:approval-arrive 8s ease-out infinite}.approval-panel>strong{display:block;font-size:13px;line-height:1.4}.approval-preview{min-height:40px;margin:9px 0;padding:7px 9px;border:1px solid #465366;border-radius:7px;background:#1b2738;font-size:12px;overflow-wrap:anywhere}.approval-preview span,.approval-preview small{color:#94a3b8}.approval-preview b{display:block}.approval-preview small{display:block;font-size:11px}.approval-options{display:grid;gap:6px}.approval-options>span{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:7px 10px;border:1px solid #4b5a6e;border-radius:7px;background:#2e3b4e;color:#e2e8f0;font-size:12px;font-weight:700}.approval-options>span:first-child{border-color:#5086cb;background:#26436c}.approval-options>span:last-child{color:#ffb4ad}.approval-options small{min-width:0;max-width:55%;overflow:hidden;color:#94a3b8;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:400}
@keyframes user-arrive{0%,8%{opacity:0;transform:translateY(6px)}22%,100%{opacity:1;transform:none}}@keyframes tool-arrive{0%,22%{opacity:0;transform:translateY(6px)}38%,100%{opacity:1;transform:none}}@keyframes result-arrive{0%,30%{opacity:0;transform:translateY(6px)}46%,100%{opacity:1;transform:none}}@keyframes approval-arrive{0%,37%{opacity:0;transform:translateY(10px)}54%,100%{opacity:1;transform:none}}@keyframes answer-arrive{0%,55%{opacity:0;transform:translateY(6px)}77%,100%{opacity:1;transform:none}}
html:has(#docs-pause-motion:checked) .wiki-chat-scene *{animation:none!important}html:has(#docs-pause-motion:checked) .wiki-chat-scene .approval-panel{opacity:1;transform:none}
@media(prefers-reduced-motion:reduce){.wiki-chat-scene *{animation:none!important}.wiki-chat-scene .approval-panel{opacity:1;transform:none}}
@media(max-width:590px){.wiki-chat-scene{height:620px}.stage-result{height:520px}.conversation{padding:11px 12px!important}.user-message{max-width:100%;font-size:11px}.stage-search .tool-call,.stage-page .tool-call{width:100%}.stage-page .tool-result{max-width:100%}.approval-panel{left:9px;right:9px;bottom:54px;padding:9px}.approval-options>span{min-height:36px;padding:7px 9px}.approval-options small{max-width:48%;overflow:visible;text-align:right;text-overflow:clip;white-space:normal;overflow-wrap:anywhere;line-height:1.3}.stage-result .conversation{padding-right:12px}.stage-result .assistant-message{max-width:100%}.composer{margin:0 9px 9px}}
</style>
