<script setup lang="ts">
import { ActivityIcon, CheckIcon, ChevronDownIcon, GlobeIcon, Loader2Icon, MousePointer2Icon, SaveIcon, Settings2Icon } from 'lucide-vue-next';
import type { OllamaGuideMessages } from '../messages';

defineProps<{ stage: 'open' | 'provider' | 'check' | 'model'; copy: OllamaGuideMessages['demo'] }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="settings-step" :class="`stage-${stage}`" :data-docs-animation="`ollama-${stage}`" :data-testid="`ollama-settings-${stage}`" aria-hidden="true">
    <aside class="app-sidebar">
      <strong class="app-brand">Naidan</strong>
      <div class="sidebar-spacer" />
      <div class="sidebar-settings"><Settings2Icon :size="14" /><span>{{ copy.settings }}</span><MousePointer2Icon v-if="stage === 'open'" class="pointer first-pointer" :size="19" /></div>
    </aside>
    <div class="app-main">
      <div class="mini-modal">
        <div class="modal-heading"><Settings2Icon :size="15" /><strong>{{ copy.settings }}</strong></div>
        <div class="modal-body">
          <div class="modal-navigation"><GlobeIcon :size="13" /><span>{{ copy.connection }}</span></div>
          <div class="modal-content">
            <div class="section-heading"><GlobeIcon :size="14" /><strong>{{ copy.endpointConfiguration }}</strong></div>
            <div class="field">
              <span class="field-label">{{ copy.apiProvider }}</span>
              <div class="select-look provider-choice">
                <span class="layered-value"><span class="provider-before">{{ copy.openaiCompatible }}</span><span class="provider-after">{{ copy.ollama }}</span></span>
                <ChevronDownIcon :size="13" /><MousePointer2Icon v-if="stage === 'provider'" class="pointer first-pointer" :size="19" />
              </div>
            </div>
            <div class="field">
              <div class="url-heading"><span class="field-label">{{ copy.endpointUrl }}</span><span class="local-preset">{{ copy.localPreset }}<MousePointer2Icon v-if="stage === 'provider'" class="pointer second-pointer" :size="19" /></span></div>
              <div class="check-row">
                <div class="url-look"><span class="url-placeholder">http://localhost:11434</span><span class="url-filled">http://localhost:11434</span></div>
                <div class="state-switch check-action">
                  <span class="check-idle"><ActivityIcon :size="13" />{{ copy.checkConnection }}</span>
                  <span class="check-loading"><Loader2Icon class="spinner" :size="13" />{{ copy.checkConnection }}</span>
                  <span class="check-done"><CheckIcon :size="13" />{{ copy.connected }}</span>
                  <MousePointer2Icon v-if="stage === 'check'" class="pointer first-pointer" :size="19" />
                </div>
              </div>
            </div>
            <div v-if="stage === 'model'" class="model-section">
              <div class="section-heading"><strong>{{ copy.modelSelection }}</strong></div>
              <div class="field">
                <span class="field-label">{{ copy.defaultModel }}</span>
                <div class="select-look model-choice">
                  <span class="layered-value"><span class="model-before">{{ copy.none }}</span><span class="model-after">{{ copy.exampleModel }}</span></span>
                  <ChevronDownIcon :size="13" /><MousePointer2Icon class="pointer first-pointer" :size="19" />
                </div>
                <small>{{ copy.usedForNewConversations }}</small>
              </div>
              <div class="save-row">
                <div class="state-switch save-action">
                  <span class="save-before"><SaveIcon :size="13" />{{ copy.saveChanges }}</span>
                  <span class="save-ready"><SaveIcon :size="13" />{{ copy.saveChanges }}</span>
                  <span class="save-done"><CheckIcon :size="13" />{{ copy.settingsSaved }}</span>
                  <MousePointer2Icon class="pointer second-pointer" :size="19" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-step { --d-panel:var(--surface);--d-field:var(--surface-2);--d-line:var(--line-strong);--d-text:var(--text);--d-muted:var(--muted);--d-blue:var(--blue);display:grid;grid-template-columns:105px minmax(0,1fr);max-width:680px;min-width:0;margin-inline:auto;border:1px solid var(--d-line);border-radius:14px;background:var(--bg);color:var(--d-text);font:11px/1.55 ui-sans-serif,system-ui,sans-serif;overflow:hidden;box-shadow:var(--panel-shadow); }
.app-sidebar { display:flex;flex-direction:column;min-width:0;padding:10px 7px;border-right:1px solid var(--d-line);background:var(--d-panel); }
.app-brand { font-size:13px;letter-spacing:-.04em; }
.sidebar-spacer { flex:1;min-height:62px; }
.sidebar-settings { position:relative;display:flex;align-items:center;gap:5px;padding:7px 5px;border:1px solid var(--d-line);border-radius:7px;color:var(--d-muted);font-weight:700; }
.sidebar-settings svg:first-child { flex:none; }
.stage-open .sidebar-settings { animation:tap-highlight 8s linear infinite; }
.app-main { min-width:0;padding:10px; }
.mini-modal { min-width:0;border:1px solid var(--d-line);border-radius:9px;background:var(--d-panel);box-shadow:0 7px 23px #0003;overflow:hidden; }
.stage-open .mini-modal { animation:modal-open 8s linear infinite; }
.modal-heading { display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid var(--d-line);font-size:12px; }
.modal-heading svg,.section-heading svg { flex:none;color:var(--d-blue); }
.modal-body { display:grid;grid-template-columns:74px minmax(0,1fr); }
.modal-navigation { display:flex;align-items:center;align-self:start;gap:4px;min-width:0;margin:6px 4px;padding:6px 4px;border:1px solid var(--d-line);border-radius:6px;background:var(--d-field);color:var(--d-blue);font-size:9px;font-weight:750;overflow-wrap:anywhere; }
.modal-navigation svg { flex:none; }
.modal-content { min-width:0;padding:8px;border-left:1px solid var(--d-line); }
.section-heading { display:flex;align-items:center;gap:6px;padding-bottom:6px;border-bottom:1px solid var(--d-line);font-size:11px;line-height:1.5; }
.field { display:grid;gap:4px;margin-top:8px; }
.field-label { color:var(--d-muted);font-size:9px;letter-spacing:.04em;font-weight:800;text-transform:uppercase; }
.select-look,.url-look { position:relative;display:flex;align-items:center;justify-content:space-between;gap:7px;min-width:0;min-height:29px;padding:5px 7px;border:1px solid var(--d-line);border-radius:6px;background:var(--d-field);color:var(--d-text);font-weight:700;overflow-wrap:anywhere; }
.select-look > svg:not(.pointer) { flex:none;color:var(--d-muted); }
.layered-value,.url-look { display:grid; }
.layered-value > span,.url-look > span { grid-area:1/1;min-width:0;overflow-wrap:anywhere; }
.stage-open .provider-after,.stage-open .url-filled,.stage-open .check-loading,.stage-open .check-done { opacity:0; }
.stage-provider .provider-before { animation:before-choice 9s linear infinite; }
.stage-provider .provider-after { opacity:0;animation:after-choice 9s linear infinite; }
.stage-check .provider-before,.stage-model .provider-before { opacity:0; }
.url-heading { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 8px; }
.local-preset { position:relative;padding:3px 6px;border:1px solid color-mix(in srgb,var(--d-blue) 40%,transparent);border-radius:6px;color:var(--d-blue);background:color-mix(in srgb,var(--d-blue) 9%,var(--d-panel));font-size:9px;font-weight:800;white-space:nowrap; }
.stage-provider .local-preset { animation:preset-highlight 9s linear infinite; }
.check-row { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:stretch; }
.url-look { font:10px/1.5 ui-monospace,SFMono-Regular,monospace; }
.url-placeholder { color:var(--d-muted); }
.stage-provider .url-placeholder { animation:before-url 9s linear infinite; }
.stage-provider .url-filled { opacity:0;animation:after-url 9s linear infinite; }
.stage-check .url-placeholder,.stage-model .url-placeholder { opacity:0; }
.state-switch { position:relative;display:grid;min-width:0; }
.state-switch > span { grid-area:1/1;display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;padding:5px 7px;border:1px solid var(--d-line);border-radius:6px;background:var(--d-field);color:var(--d-muted);font-size:10px;font-weight:800;text-align:center;overflow-wrap:anywhere; }
.state-switch > span svg { flex:none; }
.check-done,.save-done { color:var(--green)!important;border-color:color-mix(in srgb,var(--green) 45%,transparent)!important;background:color-mix(in srgb,var(--green) 10%,var(--d-panel))!important; }
.stage-provider .check-loading,.stage-provider .check-done { opacity:0; }
.stage-check .check-idle { animation:check-idle 9s linear infinite; }
.stage-check .check-loading { opacity:0;animation:check-loading 9s linear infinite; }
.stage-check .check-done { opacity:0;animation:check-done 9s linear infinite; }
.stage-model .check-idle,.stage-model .check-loading { opacity:0; }
.spinner { animation:spin 650ms linear infinite; }
.model-section { margin-top:10px;padding-top:8px;border-top:1px solid var(--d-line); }
.model-section small { color:var(--d-muted);font-size:9px;line-height:1.5; }
.model-before { animation:model-before 10s linear infinite; }
.model-after { opacity:0;animation:model-after 10s linear infinite; }
.save-row { display:flex;justify-content:flex-end;margin-top:8px;padding-top:8px;border-top:1px solid var(--d-line); }
.save-action > span { background:#2563eb;color:white;border-color:#1d4ed8; }
.save-action .save-before { background:var(--d-field);color:var(--d-muted);border-color:var(--d-line);animation:save-before 10s linear infinite; }
.save-action .save-ready { opacity:0;animation:save-ready 10s linear infinite; }
.save-action .save-done { opacity:0;animation:save-done 10s linear infinite; }
.pointer { position:absolute;z-index:3;right:0;bottom:-6px;color:var(--d-text);fill:var(--d-panel);filter:drop-shadow(0 1px 2px #0009);pointer-events:none; }
.first-pointer { animation:first-pointer 9s linear infinite; }
.sidebar-settings .first-pointer { animation-duration:8s; }
.model-choice .first-pointer { animation-duration:10s; }
.second-pointer { animation:second-pointer 9s linear infinite; }
.save-action .second-pointer { animation-duration:10s; }
@keyframes tap-highlight { 0%,8%,28%,100% { border-color:var(--d-line);background:transparent; } 15%,22% { border-color:var(--d-blue);background:color-mix(in srgb,var(--d-blue) 16%,var(--d-panel)); } }
@keyframes modal-open { 0%,32% { opacity:0;transform:translateY(4px); } 43%,92% { opacity:1;transform:none; } 100% { opacity:0;transform:none; } }
@keyframes before-choice { 0%,22%,100% { opacity:1; } 32%,91% { opacity:0; } }
@keyframes after-choice { 0%,22%,100% { opacity:0; } 32%,91% { opacity:1; } }
@keyframes preset-highlight { 0%,46%,65%,100% { box-shadow:none; } 52%,59% { box-shadow:0 0 0 4px color-mix(in srgb,var(--d-blue) 24%,transparent); } }
@keyframes before-url { 0%,54%,100% { opacity:1; } 64%,91% { opacity:0; } }
@keyframes after-url { 0%,54%,100% { opacity:0;clip-path:inset(0 100% 0 0); } 64%,91% { opacity:1;clip-path:inset(0 0 0 0); } }
@keyframes check-idle { 0%,24%,100% { opacity:1; } 34%,86% { opacity:0; } }
@keyframes check-loading { 0%,24%,100% { opacity:0; } 34%,58% { opacity:1; } 68% { opacity:0; } }
@keyframes check-done { 0%,58%,100% { opacity:0; } 68%,86% { opacity:1; } }
@keyframes spin { to { transform:rotate(360deg); } }
@keyframes model-before { 0%,24%,100% { opacity:1; } 34%,91% { opacity:0; } }
@keyframes model-after { 0%,24%,100% { opacity:0; } 34%,91% { opacity:1; } }
@keyframes save-before { 0%,34%,100% { opacity:1; } 44%,91% { opacity:0; } }
@keyframes save-ready { 0%,34%,100% { opacity:0; } 44%,62% { opacity:1; } 72% { opacity:0; } }
@keyframes save-done { 0%,62%,100% { opacity:0; } 72%,91% { opacity:1; } }
@keyframes first-pointer { 0%,7%,23%,100% { opacity:0;transform:translate(8px,8px); } 15%,18% { opacity:1;transform:translate(0,0) scale(.85); } }
@keyframes second-pointer { 0%,45%,62%,100% { opacity:0;transform:translate(8px,8px); } 51%,56% { opacity:1;transform:translate(0,0) scale(.85); } }
@media(max-width:620px) { .settings-step { grid-template-columns:72px minmax(0,1fr); } .app-sidebar { padding:8px 4px; } .app-brand { font-size:11px; } .sidebar-settings { gap:3px;padding:6px 3px;font-size:9px; } .sidebar-settings svg:first-child { width:11px; } .app-main { padding:6px; } .modal-body { grid-template-columns:59px minmax(0,1fr); } .modal-navigation { margin:5px 3px;padding:5px 3px;font-size:9px; } .modal-navigation svg { width:10px; } .modal-content { padding:6px; } .check-row { grid-template-columns:1fr; } .check-action { justify-self:start; } }
:global(html:has(#docs-pause-motion:checked)) .settings-step *,
:global(html:has(#docs-pause-motion:checked)) .settings-step *::before,
:global(html:has(#docs-pause-motion:checked)) .settings-step *::after { animation:none!important; }
:global(html:has(#docs-pause-motion:checked)) .stage-open .mini-modal { opacity:1;transform:none; }
:global(html:has(#docs-pause-motion:checked)) .stage-provider .provider-before,
:global(html:has(#docs-pause-motion:checked)) .stage-provider .url-placeholder,
:global(html:has(#docs-pause-motion:checked)) .stage-check .check-idle,
:global(html:has(#docs-pause-motion:checked)) .stage-check .check-loading,
:global(html:has(#docs-pause-motion:checked)) .stage-model .model-before,
:global(html:has(#docs-pause-motion:checked)) .stage-model .save-before,
:global(html:has(#docs-pause-motion:checked)) .stage-model .save-ready { opacity:0; }
:global(html:has(#docs-pause-motion:checked)) .stage-provider .provider-after,
:global(html:has(#docs-pause-motion:checked)) .stage-provider .url-filled,
:global(html:has(#docs-pause-motion:checked)) .stage-check .check-done,
:global(html:has(#docs-pause-motion:checked)) .stage-model .model-after,
:global(html:has(#docs-pause-motion:checked)) .stage-model .save-done { opacity:1;clip-path:none; }
:global(html:has(#docs-pause-motion:checked)) .pointer { display:none; }
@media(prefers-reduced-motion:reduce) { .settings-step *, .settings-step *::before, .settings-step *::after { animation:none!important; } .stage-open .mini-modal { opacity:1;transform:none; } .stage-provider .provider-before,.stage-provider .url-placeholder,.stage-check .check-idle,.stage-check .check-loading,.stage-model .model-before,.stage-model .save-before,.stage-model .save-ready { opacity:0; } .stage-provider .provider-after,.stage-provider .url-filled,.stage-check .check-done,.stage-model .model-after,.stage-model .save-done { opacity:1;clip-path:none; } .pointer { display:none; } }
</style>
