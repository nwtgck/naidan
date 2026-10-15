<script setup lang="ts">
import { ChevronDownIcon, FolderIcon, MousePointer2Icon, Settings2Icon } from 'lucide-vue-next';

defineProps<{ stage: 'model' | 'prompt'; messages: typeof import('../../pages/chat-groups/messages/en').messages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="group-settings-viewport" :class="`stage-${stage}`" :data-docs-animation="`group-settings-${stage}`" :data-testid="`group-settings-${stage}`" aria-hidden="true">
    <div class="scene-canvas" data-testid="group-settings-canvas">
      <aside class="app-sidebar">
        <strong class="brand">{{ messages.naidan }}</strong>
        <div class="group-row"><FolderIcon :size="18" /><span>{{ messages.translation }}</span><MousePointer2Icon v-if="stage === 'model'" class="pointer group-pointer" :size="22" /></div>
        <div class="top-chat-row">{{ messages.page_copy }}</div>
      </aside>
      <main class="workspace">
        <div v-if="stage === 'model'" class="opening-chat"><strong>{{ messages.page_copy }}</strong><div class="chat-line" /><div class="chat-line short" /></div>
        <div class="settings-page">
          <div class="page-header"><Settings2Icon :size="24" /><div><strong>{{ messages.translation_settings }}</strong><small>{{ messages.group_overrides }}</small></div></div>
          <div v-if="stage === 'model'" class="settings-card model-card">
            <div class="field"><span class="field-label">{{ messages.endpoint_type }}</span><div class="field-value inherited">{{ messages.global_ollama }}<ChevronDownIcon :size="17" /></div></div>
            <div class="field"><span class="field-label">{{ messages.model_id_override }}</span><div class="field-value model-control"><span class="value-stack"><span class="initial-value">{{ messages.global_gemma3n_e2b }}</span><strong class="selected-value">{{ messages.qwen3_4b }}</strong></span><ChevronDownIcon :size="17" /><MousePointer2Icon class="pointer model-pointer" :size="22" /></div>
              <div class="model-menu"><span>{{ messages.global_gemma3n_e2b }}</span><strong>{{ messages.qwen3_4b }}</strong></div>
            </div>
          </div>
          <div v-else class="settings-card prompt-card">
            <div class="prompt-heading"><span class="field-label">{{ messages.group_system_prompt }}</span><div class="mode-control"><span class="mode-global">{{ messages.global }}</span><span>{{ messages.no_prompt }}</span><strong class="mode-replace">{{ messages.replace }}<MousePointer2Icon class="pointer prompt-pointer" :size="22" /></strong><span>{{ messages.append }}</span></div></div>
            <span class="prompt-field-label">{{ messages.instructions_for_this_chat_group }}</span>
            <div class="prompt-input"><span class="prompt-text">{{ messages.translate_the_user_s_text_into }}</span></div>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.group-settings-viewport { --scene-line:var(--line-strong);--scene-surface:var(--surface);--scene-soft:var(--surface-2);--scene-blue:var(--blue);--scene-text:var(--text);--scene-muted:var(--muted);position:relative;width:100%;max-width:680px;height:380px;margin-inline:auto;overflow:hidden;container-type:inline-size;border:1px solid var(--scene-line);border-radius:15px;background:var(--bg);box-shadow:var(--panel-shadow);color:var(--scene-text); }
.scene-canvas { --focus-x:clamp(-185px,calc(100cqw - 660px),0px);position:absolute;left:0;top:0;width:790px;height:390px;font:14px/1.45 ui-sans-serif,system-ui,sans-serif; }
.app-sidebar { position:absolute;inset:0 auto 0 0;width:175px;padding:19px 12px;border-right:1px solid var(--scene-line);background:var(--scene-surface); }
.brand { display:block;font-size:22px;letter-spacing:-.05em; }
.group-row { position:relative;display:flex;align-items:center;gap:9px;margin-top:48px;padding:11px 10px;border-radius:9px;background:color-mix(in srgb,var(--scene-blue) 10%,var(--scene-surface));color:var(--scene-blue);font-weight:800; }
.group-row > svg:first-child { flex:none; }.top-chat-row { margin-top:16px;padding:11px 10px;border-radius:9px;background:var(--scene-soft);color:var(--scene-muted);font-size:12px; }
.pointer { position:absolute;z-index:5;fill:var(--scene-surface);color:var(--scene-text);filter:drop-shadow(0 1px 2px #0008); }
.group-pointer { right:21px;bottom:-12px;animation:group-pointer 10s linear infinite; }
.workspace { position:absolute;inset:0 0 0 175px;min-width:0;background:var(--bg); }
.opening-chat { position:absolute;inset:0;padding:27px 30px;background:var(--scene-surface); }.opening-chat strong { display:block;padding-bottom:18px;border-bottom:1px solid var(--scene-line);font-size:19px; }.chat-line { width:75%;height:21px;margin-top:49px;border-radius:8px;background:var(--scene-soft); }.chat-line.short { width:49%;margin-top:13px; }
.settings-page { opacity:1; }.stage-model .settings-page { opacity:0;animation:page-open 10s linear infinite; }.stage-model .opening-chat { animation:chat-close 10s linear infinite; }
.page-header { display:flex;align-items:center;gap:11px;min-width:0;height:75px;padding:12px 24px;border-bottom:1px solid var(--scene-line);background:var(--scene-surface); }.page-header > svg { flex:none;padding:4px;box-sizing:content-box;border-radius:9px;background:color-mix(in srgb,var(--scene-blue) 11%,var(--scene-surface));color:var(--scene-blue); }.page-header strong,.page-header small { display:block;overflow-wrap:anywhere; }.page-header strong { font-size:17px; }.page-header small { color:var(--scene-blue);font-size:10px;font-weight:800;letter-spacing:.06em; }
.settings-card { width:min(450px,calc(100cqw - 34px));margin:26px 0 0 24px;padding:22px;border:1px solid var(--scene-line);border-radius:17px;background:var(--scene-surface);box-shadow:var(--panel-shadow); }
.field + .field { margin-top:20px; }.field { position:relative; }.field-label { display:block;margin-bottom:8px;color:var(--scene-muted);font-size:11px;font-weight:850;letter-spacing:.045em; }.field-value { display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:43px;padding:9px 12px;border:1px solid var(--scene-line);border-radius:10px;background:var(--scene-soft);font-size:13px;font-weight:700;overflow-wrap:anywhere; }.field-value > svg { flex:none; }.field-value.inherited { color:var(--scene-muted); }.model-control { position:relative;border-color:var(--scene-blue); }.value-stack { display:grid;min-width:0;flex:1; }.value-stack > * { grid-area:1/1;min-width:0;overflow-wrap:anywhere; }.initial-value { color:var(--scene-muted); }.selected-value { opacity:0;color:var(--scene-blue);animation:model-selected 10s linear infinite; }.stage-model .initial-value { animation:model-inherited-leave 10s linear infinite; }.model-pointer { right:17px;bottom:-13px;animation:model-pointer 10s linear infinite; }
.model-menu { position:absolute;z-index:4;top:100%;left:0;right:0;display:grid;gap:5px;margin-top:4px;padding:6px;border:1px solid var(--scene-line);border-radius:9px;background:var(--scene-surface);box-shadow:var(--panel-shadow);opacity:0;animation:model-menu 10s linear infinite; }.model-menu > * { padding:7px 8px;border-radius:6px;overflow-wrap:anywhere; }.model-menu > span { color:var(--scene-muted); }.model-menu > strong { background:color-mix(in srgb,var(--scene-blue) 11%,var(--scene-surface));color:var(--scene-blue); }
.prompt-card { margin-top:28px; }.prompt-heading { display:grid;gap:10px; }.mode-control { display:flex;flex-wrap:wrap;gap:5px;align-items:center;padding:5px;border-radius:8px;background:var(--scene-soft); }.mode-control > * { position:relative;flex:1 1 auto;min-width:max-content;padding:6px 7px;border-radius:6px;text-align:center;color:var(--scene-muted);font-size:11px;font-weight:800; }.mode-control .mode-global { background:var(--scene-surface);color:var(--scene-blue);box-shadow:0 1px 3px #0002;animation:global-mode 10s linear infinite; }.mode-control .mode-replace { color:var(--scene-muted);animation:replace-mode 10s linear infinite; }.prompt-pointer { right:-4px;bottom:-11px;animation:prompt-pointer 10s linear infinite; }
.prompt-field-label { display:block;margin:21px 0 7px;color:var(--scene-muted);font-size:11px;font-weight:800;overflow-wrap:anywhere; }.prompt-input { min-height:93px;padding:12px;border:1px solid var(--scene-line);border-radius:10px;background:var(--scene-soft);font-size:13px;overflow-wrap:anywhere; }.prompt-text { display:block;opacity:0;animation:prompt-text 10s linear infinite; }
@keyframes group-pointer { 0%,8%,24%,100% { opacity:0;transform:translate(8px,9px); } 12%,19% { opacity:1;transform:none; } }
@keyframes page-open { 0%,22% { opacity:0; } 30%,100% { opacity:1; } }@keyframes chat-close { 0%,22% { opacity:1; } 30%,100% { opacity:0; } }
@keyframes model-pointer { 0%,38%,67%,100% { opacity:0;transform:translate(8px,8px); } 45%,59% { opacity:1;transform:none; } }
@keyframes model-menu { 0%,47%,70%,100% { opacity:0; } 54%,64% { opacity:1; } }
@keyframes model-inherited-leave { 0%,69% { opacity:1; } 76%,100% { opacity:0; } }@keyframes model-selected { 0%,69% { opacity:0; } 76%,100% { opacity:1; } }
@keyframes prompt-pointer { 0%,10%,34%,100% { opacity:0;transform:translate(8px,8px); } 17%,27% { opacity:1;transform:none; } }
@keyframes global-mode { 0%,29% { background:var(--scene-surface);color:var(--scene-blue);box-shadow:0 1px 3px #0002; } 37%,100% { background:transparent;color:var(--scene-muted);box-shadow:none; } }
@keyframes replace-mode { 0%,29% { background:transparent;color:var(--scene-muted);box-shadow:none; } 37%,100% { background:var(--scene-surface);color:var(--scene-blue);box-shadow:0 1px 3px #0002; } }
@keyframes prompt-text { 0%,47% { opacity:0; } 57%,100% { opacity:1; } }
@container (max-width:650px) { .stage-model .scene-canvas { animation:mobile-model-camera 10s linear infinite; }.stage-prompt .scene-canvas { transform:translateX(var(--focus-x)); }.settings-card { padding:16px; }.page-header { padding-inline:15px; }.page-header strong { font-size:15px; }.prompt-card { margin-top:18px; } }
@keyframes mobile-model-camera { 0%,22% { transform:none; } 36%,100% { transform:translateX(var(--focus-x)); } }
html:has(#docs-pause-motion:checked) .group-settings-viewport * { animation:none!important; }
html:has(#docs-pause-motion:checked) .stage-model .settings-page { opacity:1; }
html:has(#docs-pause-motion:checked) .stage-model .opening-chat,html:has(#docs-pause-motion:checked) .group-settings-viewport .pointer,html:has(#docs-pause-motion:checked) .stage-model .initial-value,html:has(#docs-pause-motion:checked) .stage-model .model-menu { opacity:0; }
html:has(#docs-pause-motion:checked) .stage-model .selected-value,html:has(#docs-pause-motion:checked) .stage-prompt .prompt-text { opacity:1; }
html:has(#docs-pause-motion:checked) .stage-prompt .mode-global { background:transparent;color:var(--scene-muted);box-shadow:none; }
html:has(#docs-pause-motion:checked) .stage-prompt .mode-replace { background:var(--scene-surface);color:var(--scene-blue);box-shadow:0 1px 3px #0002; }
@media(prefers-reduced-motion:reduce) { .group-settings-viewport * { animation:none!important; }.stage-model .settings-page { opacity:1; }.stage-model .opening-chat,.group-settings-viewport .pointer,.stage-model .initial-value,.stage-model .model-menu { opacity:0; }.stage-model .selected-value,.stage-prompt .prompt-text { opacity:1; }.stage-prompt .mode-global { background:transparent;color:var(--scene-muted);box-shadow:none; }.stage-prompt .mode-replace { background:var(--scene-surface);color:var(--scene-blue);box-shadow:0 1px 3px #0002; } }
@container (max-width:650px) { html:has(#docs-pause-motion:checked) .stage-model .scene-canvas { transform:translateX(var(--focus-x)); } @media(prefers-reduced-motion:reduce) { .stage-model .scene-canvas { transform:translateX(var(--focus-x)); } } }
</style>
