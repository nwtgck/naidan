<script setup lang="ts">
import { ActivityIcon, BirdIcon, BotIcon, BrainCircuitIcon, CheckCircle2Icon, CheckIcon, ChevronDownIcon, DatabaseIcon, GlobeIcon, Loader2Icon, MessageSquareIcon, MousePointer2Icon, PlusIcon, RefreshCwIcon, SaveIcon, SearchIcon, Settings2Icon, SettingsIcon, SquarePenIcon, WrenchIcon, XIcon } from 'lucide-vue-next';
import type { OllamaGuideMessages } from '../messages';

defineProps<{ stage: 'open' | 'provider' | 'check' | 'model'; copy: OllamaGuideMessages['demo'] }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="settings-camera" :class="`stage-${stage}`" :data-docs-animation="`ollama-${stage}`" :data-testid="`ollama-settings-${stage}`" aria-hidden="true">
    <div class="camera-canvas">
      <div class="app-underlay">
        <aside class="app-sidebar">
          <strong class="app-brand"><BirdIcon :size="20" />Naidan</strong>
          <div class="new-chat"><SquarePenIcon :size="16" />{{ copy.newChat }}</div>
          <div class="chat-entry"><MessageSquareIcon :size="15" />{{ copy.sampleChat }}</div>
          <div class="sidebar-fill" />
          <div class="sidebar-settings"><SettingsIcon :size="16" /><span>{{ copy.settings }}</span><MousePointer2Icon v-if="stage === 'open'" class="pointer open-pointer" :size="24" /></div>
        </aside>
        <div class="app-chat">
          <div class="chat-top"><span class="underlay-line" /><Settings2Icon :size="15" /></div>
          <div class="chat-message"><span class="avatar"><BirdIcon :size="16" /></span><div><span class="underlay-line" /><span class="underlay-line short" /></div></div>
          <div class="chat-composer"><span class="underlay-line" /><span class="underlay-line short" /></div>
        </div>
      </div>

      <div class="modal-backdrop" />
      <div class="settings-modal">
        <aside class="modal-rail">
          <div class="rail-heading"><span class="rail-heading-icon"><Settings2Icon :size="20" /></span><strong>{{ copy.settings }}</strong></div>
          <div class="rail-nav">
            <div class="rail-item selected"><GlobeIcon :size="17" /><span>{{ copy.connection }}</span></div>
            <div class="rail-item quiet"><WrenchIcon :size="17" /><span>{{ copy.tools }}</span></div>
            <div class="rail-item quiet"><BrainCircuitIcon :size="17" /><span>{{ copy.browserModels }}</span></div>
            <div class="rail-item quiet"><DatabaseIcon :size="17" /><span>{{ copy.storage }}</span></div>
          </div>
        </aside>
        <div class="modal-main">
          <div class="modal-close"><XIcon :size="18" /></div>
          <div class="modal-scroll">
            <div class="scroll-content">
              <section class="endpoint-section">
                <h3 class="section-heading"><GlobeIcon :size="18" />{{ copy.endpointConfiguration }}</h3>
                <div class="field provider-field">
                  <span class="field-label">{{ copy.apiProvider }}</span>
                  <div class="select-control provider-control">
                    <span class="value-stack"><span class="provider-before">{{ copy.openaiCompatible }}</span><span class="provider-after">{{ copy.ollama }}</span></span>
                    <ChevronDownIcon :size="17" />
                    <MousePointer2Icon v-if="stage === 'provider'" class="pointer provider-pointer" :size="23" />
                  </div>
                  <div v-if="stage === 'provider'" class="provider-menu"><span><CheckIcon :size="13" />{{ copy.openaiCompatible }}</span><strong>{{ copy.ollama }}<MousePointer2Icon class="pointer provider-option-pointer" :size="21" /></strong></div>
                </div>
                <div class="field url-field">
                  <div class="field-top"><span class="field-label">{{ copy.endpointUrl }}</span><span class="local-preset">{{ copy.localPreset }}<MousePointer2Icon v-if="stage === 'provider'" class="pointer preset-pointer" :size="23" /></span></div>
                  <div class="url-row">
                    <div class="url-control"><span class="value-stack"><span class="url-before">http://localhost:1234/v1</span><span class="url-after">http://localhost:11434</span></span></div>
                    <div class="check-control">
                      <span class="check-idle"><ActivityIcon :size="16" />{{ copy.checkConnection }}</span>
                      <span class="check-loading"><Loader2Icon class="spinner" :size="16" />{{ copy.checkConnection }}</span>
                      <span class="check-done"><CheckIcon :size="16" />{{ copy.connected }}</span>
                      <MousePointer2Icon v-if="stage === 'check'" class="pointer check-pointer" :size="23" />
                    </div>
                  </div>
                  <div class="local-help"><GlobeIcon :size="15" /><span>{{ copy.localhostHint }}</span></div>
                </div>
                <div class="headers-hint"><span class="field-label">{{ copy.customHttpHeaders }}</span><span><PlusIcon :size="12" />{{ copy.addHeader }}</span></div>
              </section>
              <section class="model-section">
                <h3 class="section-heading"><BotIcon :size="18" />{{ copy.modelSelection }}</h3>
                <div class="field"><span class="field-label">{{ copy.defaultModel }}</span>
                  <div class="select-control model-control"><span class="value-stack"><span class="model-before">{{ copy.none }}</span><span class="model-after">{{ copy.exampleModel }}</span></span><ChevronDownIcon :size="17" /><MousePointer2Icon v-if="stage === 'model'" class="pointer model-pointer" :size="23" /></div>
                  <div v-if="stage === 'model'" class="model-menu"><div class="model-menu-tools"><span class="model-search"><SearchIcon :size="14" />{{ copy.filterModels }}</span><span class="model-refresh" :title="copy.refreshModelList"><RefreshCwIcon :size="14" /></span></div><span class="model-option"><span>{{ copy.none }}</span><CheckIcon class="none-check" :size="14" /></span><strong class="model-option model-option-target">{{ copy.exampleModel }}<MousePointer2Icon class="pointer model-option-pointer" :size="21" /></strong></div>
                  <small>{{ copy.usedWhenInherited }}</small>
                </div>
              </section>
            </div>
          </div>
          <div class="modal-footer"><span class="save-button"><span class="save-before"><SaveIcon :size="16" />{{ copy.saveChanges }}</span><span class="save-after"><CheckCircle2Icon :size="16" />{{ copy.settingsSaved }}</span><MousePointer2Icon v-if="stage === 'model'" class="pointer save-pointer" :size="23" /></span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-camera { --panel:var(--surface);--field:var(--surface-2);--line:var(--line-strong);--ink:var(--text);--muted-ink:var(--muted);--accent:var(--blue);--camera-zoom:.92;--camera-x:0px;--camera-y:-30px;position:relative;max-width:680px;height:340px;margin-inline:auto;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:var(--panel-shadow);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,sans-serif;overflow:hidden;isolation:isolate;container-type:inline-size; }
.settings-camera * { box-sizing:border-box; }
.camera-canvas { position:absolute;top:0;left:calc(50% - 490px);width:980px;height:720px;transform-origin:top left;transform:translate(var(--camera-x),var(--camera-y)) scale(var(--camera-zoom)); }
.stage-open .camera-canvas { animation:camera-approach 8s ease-in-out infinite both; }
.stage-check { --camera-y:-95px; }.stage-check .camera-canvas { animation:camera-check 9s ease-in-out infinite both; }
.stage-model { --camera-y:-295px; }.stage-model .camera-canvas { animation:camera-model 10s ease-in-out infinite both; }.stage-model .scroll-content { animation:content-scroll 10s ease-in-out infinite both; }
.app-underlay { display:grid;grid-template-columns:228px minmax(0,1fr);height:720px;background:var(--panel); }
.app-sidebar { display:flex;flex-direction:column;gap:12px;padding:22px 15px;border-right:1px solid var(--line);background:var(--field); }
.app-brand { display:flex;align-items:center;gap:8px;font-size:18px;letter-spacing:-.04em; }.app-brand svg { color:var(--accent); }
.new-chat,.chat-entry,.sidebar-settings { display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:9px; }.new-chat { margin-top:10px;background:#2563eb;color:white; }.chat-entry { color:var(--muted-ink); }.sidebar-fill { flex:1; }.sidebar-settings { position:relative;border:1px solid var(--line);font-weight:750;background:var(--panel); }
.underlay-line { display:block;width:90px;height:8px;border-radius:8px;background:color-mix(in srgb,var(--muted-ink) 28%,transparent); }.underlay-line.short { width:54px; }
.app-chat { display:flex;flex-direction:column; }.chat-top { display:flex;align-items:center;justify-content:space-between;padding:22px;border-bottom:1px solid var(--line);color:var(--muted-ink); }.chat-message { display:flex;align-items:center;gap:12px;margin:45px 70px; }.chat-message > div { display:grid;gap:11px; }.avatar { display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--field);color:var(--accent); }.chat-composer { display:grid;gap:16px;margin:auto 36px 34px;padding:19px;border:1px solid var(--line);border-radius:15px;background:var(--field); }
.modal-backdrop { position:absolute;inset:0;background:#0008; }.settings-modal { position:absolute;left:130px;top:48px;display:grid;grid-template-columns:200px 620px;width:820px;height:630px;border:1px solid var(--line);border-radius:22px;background:var(--panel);box-shadow:0 24px 65px #0007;overflow:hidden; }
.stage-open .modal-backdrop,.stage-open .settings-modal { animation:modal-appear 8s ease-in-out infinite both; }
.modal-rail { min-width:0;border-right:1px solid var(--line);background:var(--field); }.rail-heading { display:flex;align-items:center;gap:11px;height:76px;padding:17px;border-bottom:1px solid var(--line);font-size:18px; }.rail-heading-icon { display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--line);border-radius:11px;background:var(--panel);color:var(--accent); }.rail-nav { display:grid;gap:6px;padding:16px 11px; }.rail-item { display:flex;align-items:center;gap:10px;height:43px;padding:10px;border:1px solid transparent;border-radius:11px;font-size:13px;font-weight:750; }.rail-item.selected { border-color:var(--line);background:var(--panel);color:var(--accent);box-shadow:0 4px 10px #0001; }.rail-item.quiet { color:var(--muted-ink); }
.modal-main { position:relative;min-width:0; }.modal-close { position:absolute;z-index:2;top:17px;right:18px;color:var(--muted-ink); }.modal-scroll { height:566px;padding:31px 78px 18px 34px;overflow:hidden; }.section-heading { display:flex;align-items:center;gap:9px;margin:0 0 22px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:20px;letter-spacing:-.025em; }.section-heading svg { flex:none;color:var(--accent); }
.field { position:relative;display:grid;gap:8px;min-width:0; }.field-label { color:var(--muted-ink);font-size:12px;font-weight:800;letter-spacing:.07em;text-transform:uppercase; }.select-control,.url-control { display:flex;align-items:center;justify-content:space-between;min-width:0;height:47px;padding:0 14px;border:1px solid var(--line);border-radius:11px;background:var(--field);font-weight:700; }.select-control > svg:not(.pointer) { flex:none;color:var(--muted-ink); }.value-stack { display:grid;min-width:0; }.value-stack > span { grid-area:1/1;min-width:0;overflow-wrap:anywhere; }.provider-control,.model-control { position:relative; }.provider-field { margin-bottom:22px; }.provider-after,.url-after,.model-after { opacity:0; }
.provider-menu { position:absolute;z-index:3;left:0;right:0;top:75px;display:grid;gap:2px;padding:6px;border:1px solid var(--line);border-radius:11px;background:var(--panel);box-shadow:0 10px 23px #0005;opacity:0;transform:translateY(-7px) scaleY(.94);transform-origin:top;animation:provider-menu 9s linear infinite; }.provider-menu > * { display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px; }.provider-menu strong { position:relative;background:color-mix(in srgb,var(--accent) 12%,var(--panel));color:var(--accent); }.provider-menu .provider-option-pointer { right:auto;left:80px;bottom:-5px;animation:provider-option-pointer 9s linear infinite; }.stage-provider .provider-control > svg:not(.pointer) { animation:provider-chevron 9s linear infinite; }
.field-top { display:flex;align-items:center;justify-content:space-between;gap:8px; }.local-preset { position:relative;padding:5px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--accent);font-size:11px;font-weight:800;white-space:nowrap; }.url-row { display:grid;grid-template-columns:minmax(0,1fr) 175px;gap:8px; }.url-control { font:700 13px/1.4 ui-monospace,SFMono-Regular,monospace; }.check-control { position:relative;display:grid;min-width:0;border:1px solid var(--line);border-radius:11px;background:var(--field);color:var(--muted-ink);font-size:12px;font-weight:750; }.check-control > span { grid-area:1/1;display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;padding:4px;text-align:center; }.check-control svg { flex:none; }.check-loading,.check-done { opacity:0; }.check-done { color:var(--green); }.spinner { animation:spin 650ms linear infinite; }.local-help { display:flex;align-items:flex-start;gap:9px;margin-top:12px;padding:11px;border:1px solid color-mix(in srgb,var(--accent) 18%,var(--line));border-radius:10px;background:color-mix(in srgb,var(--accent) 7%,var(--panel));color:var(--accent);font-size:11px; }.local-help svg { flex:none; }.headers-hint { display:flex;justify-content:space-between;gap:8px;margin:23px 0 26px; }.headers-hint > span:last-child { display:flex;align-items:center;gap:4px;color:var(--accent);font-size:11px;font-weight:750; }
.model-section { border-top:1px solid var(--line);padding-top:21px; }.model-section .section-heading { margin-bottom:17px; }.model-section small { color:var(--muted-ink);font-size:11px; }.model-menu { position:absolute;z-index:4;top:75px;left:0;width:min(400px,100%);padding:5px;border:1px solid var(--line);border-radius:11px;background:var(--panel);box-shadow:0 13px 27px #0005;opacity:0;transform:translateY(-8px) scaleY(.94);transform-origin:top;animation:model-menu 10s linear infinite; }.model-menu-tools { display:flex;align-items:center;gap:7px;padding:5px 6px 8px;border-bottom:1px solid var(--line);background:var(--field); }.model-search { display:flex;align-items:center;gap:7px;flex:1;min-width:0;padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted-ink);font-size:11px; }.model-refresh { display:grid;place-items:center;padding:6px;border:1px solid var(--line);border-radius:7px;color:var(--muted-ink); }.model-option { display:flex;align-items:center;justify-content:space-between;min-height:29px;padding:5px 9px;color:var(--muted-ink);font-size:12px; }.none-check { color:var(--accent); }.model-option-target { position:relative;border-radius:6px;color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--panel)); }.model-option-pointer { right:11px;bottom:-6px;animation:model-option-pointer 10s linear infinite; }.stage-model .model-control > svg:not(.pointer) { animation:model-chevron 10s linear infinite; }.modal-footer { display:flex;align-items:center;justify-content:flex-end;height:64px;padding:10px 70px 10px 32px;border-top:1px solid var(--line);background:var(--field); }.save-button { position:relative;display:grid;min-width:156px;min-height:39px;border-radius:11px;background:#2563eb;color:white;font-size:12px;font-weight:800; }.save-button > span { grid-area:1/1;display:flex;align-items:center;justify-content:center;gap:7px;padding:6px 10px; }.save-after { opacity:0; }.pointer { position:absolute;z-index:5;right:-7px;bottom:-8px;fill:var(--panel);color:var(--ink);filter:drop-shadow(0 2px 2px #000a);pointer-events:none; }.open-pointer { animation:open-pointer 8s linear infinite; }.provider-pointer { animation:provider-pointer 9s linear infinite; }.preset-pointer { animation:preset-pointer 9s linear infinite; }.check-pointer { animation:check-pointer 9s linear infinite; }.model-pointer { animation:model-pointer 10s linear infinite; }.save-pointer { animation:save-pointer 10s linear infinite; }
.stage-provider .provider-before { animation:provider-before 9s linear infinite; }.stage-provider .provider-after { animation:provider-after 9s linear infinite; }.stage-provider .url-before { animation:url-before 9s linear infinite; }.stage-provider .url-after { animation:url-after 9s linear infinite; }.stage-provider .local-preset { animation:preset-select 9s linear infinite; }
.stage-check .provider-before,.stage-model .provider-before,.stage-check .url-before,.stage-model .url-before { opacity:0; }.stage-check .provider-after,.stage-model .provider-after,.stage-check .url-after,.stage-model .url-after { opacity:1; }.stage-check .local-preset,.stage-model .local-preset { background:#2563eb;border-color:#1d4ed8;color:white; }
.stage-check .check-idle { animation:check-idle 9s linear infinite; }.stage-check .check-loading { animation:check-loading 9s linear infinite; }.stage-check .check-done { animation:check-done 9s linear infinite; }.stage-model .check-idle { opacity:0;animation:model-check-idle 10s linear infinite; }.stage-model .check-done { opacity:1;animation:model-check-done 10s linear infinite; }
.stage-model .model-before { animation:model-before 10s linear infinite; }.stage-model .model-after { animation:model-after 10s linear infinite; }.stage-model .save-before { animation:save-before 10s linear infinite; }.stage-model .save-after { animation:save-after 10s linear infinite; }
@keyframes camera-approach { 0%,24% { transform:translate(180px,-430px) scale(.92); } 43%,91% { transform:translate(0,-30px) scale(.92); } 100% { transform:translate(180px,-430px) scale(.92); } }
@keyframes camera-check { 0%,16% { transform:translate(0,-30px) scale(.92); } 30%,91% { transform:translate(0,-95px) scale(.92); } 100% { transform:translate(0,-30px) scale(.92); } }
@keyframes camera-model { 0%,16% { transform:translate(0,-95px) scale(.92); } 32%,91% { transform:translate(0,-295px) scale(.92); } 100% { transform:translate(0,-95px) scale(.92); } }
@keyframes content-scroll { 0%,16%,100% { transform:translateY(0); } 32%,91% { transform:translateY(-135px); } }
@keyframes modal-appear { 0%,28%,100% { opacity:0; } 39%,92% { opacity:1; } }
@keyframes open-pointer { 0%,7%,27%,100% { opacity:0;transform:translate(9px,8px); } 15%,21% { opacity:1;transform:none; } }
@keyframes provider-pointer { 0%,8%,28%,100% { opacity:0;transform:translate(8px,8px); } 15%,22% { opacity:1;transform:none; } }
@keyframes provider-menu { 0%,14%,32%,100% { opacity:0;transform:translateY(-7px) scaleY(.94); } 20%,29% { opacity:1;transform:none; } }
@keyframes provider-chevron { 0%,15%,32%,100% { transform:none; } 20%,29% { transform:rotate(180deg); } }
@keyframes provider-option-pointer { 0%,21%,32%,100% { opacity:0;transform:translate(8px,8px); } 24%,29% { opacity:1;transform:none; } }
@keyframes provider-before { 0%,28%,100% { opacity:1; } 38%,92% { opacity:0; } }
@keyframes provider-after { 0%,28%,100% { opacity:0; } 38%,92% { opacity:1; } }
@keyframes preset-pointer { 0%,44%,64%,100% { opacity:0;transform:translate(8px,8px); } 51%,58% { opacity:1;transform:none; } }
@keyframes preset-select { 0%,58%,100% { background:var(--panel);border-color:var(--line);color:var(--accent); } 68%,92% { background:#2563eb;border-color:#1d4ed8;color:white; } }
@keyframes url-before { 0%,58%,100% { opacity:1; } 68%,92% { opacity:0; } }
@keyframes url-after { 0%,58%,100% { opacity:0; } 68%,92% { opacity:1; } }
@keyframes check-pointer { 0%,8%,31%,100% { opacity:0;transform:translate(8px,8px); } 15%,23% { opacity:1;transform:none; } }
@keyframes check-idle { 0%,28%,100% { opacity:1; } 38%,92% { opacity:0; } }
@keyframes check-loading { 0%,28%,66%,100% { opacity:0; } 38%,56% { opacity:1; } }
@keyframes check-done { 0%,62%,100% { opacity:0; } 72%,92% { opacity:1; } }
@keyframes model-check-idle { 0%,20% { opacity:0; } 30%,100% { opacity:1; } }
@keyframes model-check-done { 0%,20% { opacity:1; } 30%,100% { opacity:0; } }
@keyframes model-pointer { 0%,32%,48%,100% { opacity:0;transform:translate(8px,8px); } 37%,44% { opacity:1;transform:none; } }
@keyframes model-menu { 0%,39%,54%,100% { opacity:0;transform:translateY(-8px) scaleY(.94); } 43%,50% { opacity:1;transform:none; } }
@keyframes model-chevron { 0%,39%,54%,100% { transform:none; } 43%,50% { transform:rotate(180deg); } }
@keyframes model-option-pointer { 0%,43%,54%,100% { opacity:0;transform:translate(8px,8px); } 46%,50% { opacity:1;transform:none; } }
@keyframes model-before { 0%,45%,100% { opacity:1; } 55%,92% { opacity:0; } }
@keyframes model-after { 0%,45%,100% { opacity:0; } 55%,92% { opacity:1; } }
@keyframes save-pointer { 0%,58%,79%,100% { opacity:0;transform:translate(8px,8px); } 65%,72% { opacity:1;transform:none; } }
@keyframes save-before { 0%,73%,100% { opacity:1; } 83%,92% { opacity:0; } }
@keyframes save-after { 0%,73%,100% { opacity:0; } 83%,92% { opacity:1; } }
@keyframes spin { to { transform:rotate(360deg); } }
@media(max-width:600px) { .settings-camera { --camera-zoom:.85;--camera-x:-291px;--camera-y:-15px;height:310px; }.camera-canvas { left:0; }.model-menu { width:280px; }.stage-provider .camera-canvas { animation:camera-provider-narrow 9s ease-in-out infinite both; }.stage-check { --camera-x:calc(100cqw - 759px);--camera-y:-65px; }.stage-model { --camera-x:calc(100cqw - 766px);--camera-y:-270px; }.stage-open .camera-canvas { animation-name:camera-approach-narrow; }.stage-check .camera-canvas { animation-name:camera-check-narrow; }.stage-model .camera-canvas { animation-name:camera-model-narrow; } }
@keyframes camera-approach-narrow { 0%,24% { transform:translate(20px,-430px) scale(.85); } 43%,91% { transform:translate(-291px,-15px) scale(.85); } 100% { transform:translate(20px,-430px) scale(.85); } }
@keyframes camera-provider-narrow { 0%,36% { transform:translate(-291px,-15px) scale(.85); } 49%,65% { transform:translate(calc(100cqw - 759px),-15px) scale(.85); } 79%,91% { transform:translate(-291px,-15px) scale(.85); } 100% { transform:translate(-291px,-15px) scale(.85); } }
@keyframes camera-check-narrow { 0%,16% { transform:translate(-291px,-15px) scale(.85); } 30%,91% { transform:translate(calc(100cqw - 759px),-65px) scale(.85); } 100% { transform:translate(-291px,-15px) scale(.85); } }
@keyframes camera-model-narrow { 0%,16% { transform:translate(calc(100cqw - 759px),-65px) scale(.85); } 31%,52% { transform:translate(-291px,-270px) scale(.85); } 63%,91% { transform:translate(calc(100cqw - 766px),-270px) scale(.85); } 100% { transform:translate(calc(100cqw - 759px),-65px) scale(.85); } }
:global(html:has(#docs-pause-motion:checked)) .settings-camera *, :global(html:has(#docs-pause-motion:checked)) .settings-camera *::before, :global(html:has(#docs-pause-motion:checked)) .settings-camera *::after { animation:none!important; }
:global(html:has(#docs-pause-motion:checked)) .stage-open .modal-backdrop, :global(html:has(#docs-pause-motion:checked)) .stage-open .settings-modal { opacity:1; }
:global(html:has(#docs-pause-motion:checked)) .stage-provider .provider-before, :global(html:has(#docs-pause-motion:checked)) .stage-provider .url-before, :global(html:has(#docs-pause-motion:checked)) .stage-check .check-idle, :global(html:has(#docs-pause-motion:checked)) .stage-check .check-loading, :global(html:has(#docs-pause-motion:checked)) .stage-model .model-before, :global(html:has(#docs-pause-motion:checked)) .stage-model .save-before { opacity:0; }
:global(html:has(#docs-pause-motion:checked)) .stage-provider .provider-after, :global(html:has(#docs-pause-motion:checked)) .stage-provider .url-after, :global(html:has(#docs-pause-motion:checked)) .stage-check .check-done, :global(html:has(#docs-pause-motion:checked)) .stage-model .model-after, :global(html:has(#docs-pause-motion:checked)) .stage-model .save-after { opacity:1; }
:global(html:has(#docs-pause-motion:checked)) .stage-model .check-idle { opacity:1; }
:global(html:has(#docs-pause-motion:checked)) .stage-model .check-done { opacity:0; }
:global(html:has(#docs-pause-motion:checked)) .stage-provider .local-preset { background:#2563eb;border-color:#1d4ed8;color:white; }
:global(html:has(#docs-pause-motion:checked)) .stage-model .scroll-content { transform:translateY(-135px); }
:global(html:has(#docs-pause-motion:checked)) .settings-camera .pointer { display:none; }
@media(prefers-reduced-motion:reduce) { .settings-camera *, .settings-camera *::before, .settings-camera *::after { animation:none!important; } .stage-open .modal-backdrop,.stage-open .settings-modal { opacity:1; } .stage-provider .provider-before,.stage-provider .url-before,.stage-check .check-idle,.stage-check .check-loading,.stage-model .model-before,.stage-model .save-before,.stage-model .check-done { opacity:0; } .stage-provider .provider-after,.stage-provider .url-after,.stage-check .check-done,.stage-model .model-after,.stage-model .save-after,.stage-model .check-idle { opacity:1; } .stage-provider .local-preset { background:#2563eb;border-color:#1d4ed8;color:white; } .stage-model .scroll-content { transform:translateY(-135px); } .pointer { display:none; } }
</style>
