<script setup lang="ts">
import { BookmarkPlusIcon, BotIcon, CheckCircle2Icon, ChevronDownIcon, DownloadIcon, GlobeIcon, LinkIcon, Loader2Icon, MousePointer2Icon, SaveIcon } from 'lucide-vue-next';
import SettingsCameraFrame from './SettingsCameraFrame.vue';
import type { messages as english } from '../../pages/endpoint-type-browser-provided-lm/messages/en';

defineProps<{
  stage: 'open' | 'select' | 'prepare' | 'save',
  messages: typeof english,
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="browser-scene" :class="`stage-${stage}`">
    <SettingsCameraFrame :focus="stage" :messages="messages" :animation-id="`browser-provided-${stage}`" :test-id="`browser-provided-settings-${stage}`">
      <div class="guide-content">
        <div class="section-heading">
          <div><GlobeIcon :size="19" /><strong>{{ messages.endpoint_configuration }}</strong></div>
          <span class="copy-url"><LinkIcon :size="13" />{{ messages.copy_setup_url }}</span>
        </div>

        <div class="field provider-field">
          <span class="field-label">{{ messages.api_provider }}</span>
          <div class="field-box">
            <span class="layered"><span class="provider-before">{{ messages.ollama }}</span><span class="provider-after">{{ messages.browser_provided_provider_option }}</span></span>
            <ChevronDownIcon :size="17" />
            <MousePointer2Icon v-if="stage === 'select'" class="pointer provider-pointer" :size="25" />
          </div>
          <div v-if="stage === 'select'" class="provider-options">
            <span>{{ messages.ollama }}</span>
            <span class="provider-option-target">{{ messages.browser_provided_provider_option }}<MousePointer2Icon class="pointer option-pointer" :size="25" /></span>
          </div>
        </div>

        <div class="conditional-area">
          <div class="url-area">
            <div class="field">
              <span class="field-label">{{ messages.endpoint_url }}</span>
              <div class="field-box placeholder-url">{{ messages.local_url_placeholder }}</div>
            </div>
          </div>
          <div class="status-panel">
            <p class="managed">{{ messages.browser_managed_model_note }}</p>
            <div class="status-line">
              <span class="status-icon"><Loader2Icon class="checking-icon spinner" :size="18" /><DownloadIcon class="download-icon" :size="18" /><CheckCircle2Icon class="ready-icon" :size="18" /></span>
              <span class="status-copy"><span class="checking">{{ messages.checking_browser_model }}</span><span class="offered">{{ messages.prepare_browser_model }}</span><span class="downloading">{{ messages.downloading_browser_model }}</span><span class="preparing">{{ messages.preparing_browser_model }}</span><span class="ready">{{ messages.browser_model_ready }}</span></span>
              <span class="prepare-action">{{ messages.prepare_browser_model }}<MousePointer2Icon v-if="stage === 'prepare'" class="pointer prepare-pointer" :size="25" /></span>
            </div>
            <div class="progress-track"><span class="progress-fill" /></div>
          </div>
        </div>

        <div class="model-section">
          <div class="section-heading"><div><BotIcon :size="19" /><strong>{{ messages.model_selection }}</strong></div></div>
          <div class="field">
            <span class="field-label">{{ messages.default_model }}</span>
            <div class="field-box model-box disabled-model"><span class="layered"><span class="model-before">{{ messages.none }}</span><span class="model-after">{{ messages.browser_model_id }}</span></span><ChevronDownIcon :size="17" /></div>
            <small>{{ messages.inherited_connection_note }}</small>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="secondary-save"><BookmarkPlusIcon :size="16" />{{ messages.save_as_new_profile }}</div>
        <div class="save-action"><span class="save-idle"><SaveIcon :size="16" />{{ messages.save_changes }}</span><span class="save-done"><CheckCircle2Icon :size="16" />{{ messages.settings_saved }}</span><MousePointer2Icon v-if="stage === 'save'" class="pointer save-pointer" :size="25" /></div>
      </template>
    </SettingsCameraFrame>
  </div>
</template>

<style scoped>
.browser-scene{--field:var(--surface-2);--panel:var(--surface);--line:var(--line-strong);--ink:var(--text);--muted:var(--muted);--accent:var(--blue);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.guide-content{width:570px;color:var(--ink)}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:18px}.section-heading>div{display:flex;align-items:center;gap:10px}.section-heading svg{color:var(--accent)}
.copy-url{display:flex;align-items:center;gap:5px;padding:5px 9px;border:1px solid color-mix(in srgb,var(--accent) 25%,var(--line));border-radius:8px;background:color-mix(in srgb,var(--accent) 6%,var(--panel));color:var(--accent);font-size:11px;font-weight:750}
.field{position:relative;display:grid;gap:8px;margin-top:23px}.field-label{color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.provider-options{position:absolute;z-index:4;top:100%;left:0;right:0;display:grid;padding:5px;border:1px solid var(--line);border-radius:11px;background:var(--panel);box-shadow:0 14px 30px #0004;opacity:0;transform:translateY(-7px) scaleY(.94);transform-origin:top;animation:provider-options 9s linear infinite}.provider-options>span{position:relative;padding:8px 10px;border-radius:7px;font-size:12px;font-weight:700}.provider-option-target{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--panel))}.stage-select .provider-field .field-box>svg:not(.pointer){animation:provider-chevron 9s linear infinite}
.field-box{position:relative;display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px;padding:10px 14px;border:1px solid var(--line);border-radius:11px;background:var(--field);font-weight:700;overflow-wrap:anywhere}.field-box>svg{flex:none;color:var(--muted)}
.layered{display:grid;min-width:0}.layered>span{grid-area:1/1;overflow-wrap:anywhere}.provider-after,.model-after{opacity:0}.stage-select .provider-before{animation:provider-before 9s linear infinite}.stage-select .provider-after{animation:provider-after 9s linear infinite}.stage-prepare .provider-before,.stage-save .provider-before{opacity:0}.stage-prepare .provider-after,.stage-save .provider-after{opacity:1}
.conditional-area{display:grid;align-items:start;margin-top:20px;min-height:172px}.conditional-area>*{grid-area:1/1}.url-area .field{margin-top:0}.placeholder-url{color:var(--muted);font:13px/1.4 ui-monospace,SFMono-Regular,monospace}.stage-select .url-area{animation:url-disappear 9s linear infinite}.stage-prepare .url-area,.stage-save .url-area{opacity:0}
.status-panel{min-height:172px;padding:14px 17px;border:1px solid color-mix(in srgb,var(--accent) 26%,var(--line));border-radius:15px;background:color-mix(in srgb,var(--accent) 8%,var(--panel));opacity:0}.stage-select .status-panel{animation:status-appear 9s linear infinite}.stage-prepare .status-panel,.stage-save .status-panel{opacity:1}
.managed{margin:0 0 15px;color:var(--muted);font-size:11px}.status-line{display:flex;align-items:center;gap:12px;min-height:54px}
.status-icon{display:grid;flex:none;color:var(--accent)}.status-icon svg{grid-area:1/1}.status-copy{display:grid;min-width:0;flex:1;font-size:12px;font-weight:750;overflow-wrap:anywhere}.status-copy>span{grid-area:1/1}
.checking,.offered,.downloading,.preparing,.ready,.download-icon,.ready-icon{opacity:0}
.stage-select .checking,.stage-select .checking-icon{animation:check-state 9s linear infinite}.stage-select .offered,.stage-select .download-icon{animation:offered-state 9s linear infinite}
.stage-prepare .offered,.stage-prepare .download-icon{animation:prepare-offered 10s linear infinite}.stage-prepare .downloading{animation:prepare-downloading 10s linear infinite}.stage-prepare .preparing,.stage-prepare .checking-icon{animation:prepare-preparing 10s linear infinite}.stage-prepare .ready,.stage-prepare .ready-icon{animation:prepare-ready 10s linear infinite}
.stage-save .checking-icon,.stage-save .download-icon{opacity:0}.stage-save .ready,.stage-save .ready-icon{opacity:1}
.prepare-action{position:relative;max-width:190px;padding:8px 10px;border-radius:10px;background:#2563eb;color:white;font-size:11px;font-weight:800;text-align:center;overflow-wrap:anywhere;opacity:0}.stage-select .prepare-action{animation:show-prepare 9s linear infinite}.stage-prepare .prepare-action{animation:hide-prepare 10s linear infinite}
.progress-track{height:6px;margin-top:12px;border-radius:8px;background:color-mix(in srgb,var(--accent) 20%,var(--panel));opacity:0}.stage-prepare .progress-track{animation:progress-visibility 10s linear infinite}.progress-fill{display:block;width:100%;height:100%;border-radius:inherit;background:var(--accent);transform:scaleX(0);transform-origin:left}.stage-prepare .progress-fill{animation:progress-fill 10s linear infinite}
.model-section{margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}.model-section .field{margin-top:17px}.model-section small{color:var(--muted);font-size:11px}.stage-select .model-before{animation:model-before 9s linear infinite}.stage-select .model-after{animation:model-after 9s linear infinite}.stage-prepare .model-before,.stage-save .model-before{opacity:0}.stage-prepare .model-after,.stage-save .model-after{opacity:1}
.stage-select .model-box{animation:model-disabled 9s linear infinite}.stage-prepare .model-box,.stage-save .model-box{opacity:.55}.secondary-save{display:flex;align-items:center;gap:6px;padding:10px 14px;border:1px solid var(--line);border-radius:11px;background:var(--panel);color:var(--muted);font-size:12px;font-weight:700}
.save-action{position:relative;display:grid}.save-action>span{grid-area:1/1;display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 24px;border:1px solid #1d4ed8;border-radius:11px;background:#2563eb;color:white;font-size:12px;font-weight:800;white-space:nowrap}.save-action svg{flex:none}.save-idle{opacity:.55}.stage-select .save-idle,.stage-prepare .save-idle{opacity:1}.save-done{opacity:0;color:var(--green)!important;border-color:var(--green)!important;background:color-mix(in srgb,var(--green) 10%,var(--panel))!important}.stage-save .save-idle{animation:save-idle 9s linear infinite}.stage-save .save-done{animation:save-done 9s linear infinite}
.pointer{position:absolute;z-index:3;right:5px;bottom:-10px;color:var(--ink);fill:var(--panel);filter:drop-shadow(0 2px 3px #0008);pointer-events:none}.provider-pointer{animation:provider-pointer 9s linear infinite}.prepare-pointer{animation:prepare-pointer 10s linear infinite}.save-pointer{animation:save-pointer 9s linear infinite}
@keyframes provider-options{0%,22%,36%,100%{opacity:0;transform:translateY(-7px) scaleY(.94)}26%,33%{opacity:1;transform:none}}@keyframes provider-chevron{0%,22%,36%,100%{transform:none}26%,33%{transform:rotate(180deg)}}@keyframes option-pointer{0%,26%,36%,100%{opacity:0;transform:translate(10px,8px)}29%,33%{opacity:1;transform:none}}.option-pointer{right:auto;left:175px;animation:option-pointer 9s linear infinite}
@keyframes provider-before{0%,24%,100%{opacity:1}35%,92%{opacity:0}}@keyframes provider-after{0%,24%,100%{opacity:0}35%,92%{opacity:1}}
@keyframes url-disappear{0%,24%,100%{opacity:1}35%,92%{opacity:0}}@keyframes status-appear{0%,24%,100%{opacity:0}35%,92%{opacity:1}}
@keyframes check-state{0%,36%,100%{opacity:1}47%,92%{opacity:0}}@keyframes offered-state{0%,36%,100%{opacity:0}47%,92%{opacity:1}}@keyframes show-prepare{0%,36%,100%{opacity:0}47%,92%{opacity:1}}
@keyframes prepare-offered{0%,22%,100%{opacity:1}33%,92%{opacity:0}}@keyframes prepare-downloading{0%,22%,100%{opacity:0}33%,55%{opacity:1}65%{opacity:0}}@keyframes prepare-preparing{0%,55%,100%{opacity:0}65%,75%{opacity:1}85%{opacity:0}}@keyframes prepare-ready{0%,75%,100%{opacity:0}85%,92%{opacity:1}}
@keyframes hide-prepare{0%,22%,100%{opacity:1}33%,92%{opacity:0}}@keyframes progress-visibility{0%,24%,75%,100%{opacity:0}35%,65%{opacity:1}}@keyframes progress-fill{0%,30%{transform:scaleX(0)}70%,100%{transform:scaleX(1)}}@keyframes spinner{to{transform:rotate(360deg)}}
@keyframes model-before{0%,24%,100%{opacity:1}35%,92%{opacity:0}}@keyframes model-after{0%,24%,100%{opacity:0}35%,92%{opacity:1}}@keyframes save-idle{0%,49%,100%{opacity:1}60%,92%{opacity:0}}@keyframes save-done{0%,49%,100%{opacity:0}60%,92%{opacity:1}}
@keyframes model-disabled{0%,24%,100%{opacity:1}35%,92%{opacity:.55}}
@keyframes provider-pointer{0%,8%,29%,100%{opacity:0;transform:translate(10px,8px)}15%,22%{opacity:1;transform:none}}@keyframes prepare-pointer{0%,8%,28%,100%{opacity:0;transform:translate(10px,8px)}15%,22%{opacity:1;transform:none}}@keyframes save-pointer{0%,38%,60%,100%{opacity:0;transform:translate(10px,8px)}46%,53%{opacity:1;transform:none}}
@media(max-width:700px){.guide-content{width:460px}.section-heading{font-size:16px}.status-line{gap:8px}.prepare-action{max-width:145px;font-size:10px}.status-copy{font-size:11px}.secondary-save{font-size:10px}}
html:has(#docs-pause-motion:checked) .browser-scene *{animation:none!important}
html:has(#docs-pause-motion:checked) .stage-select .provider-before,html:has(#docs-pause-motion:checked) .stage-select .url-area,html:has(#docs-pause-motion:checked) .stage-select .checking,html:has(#docs-pause-motion:checked) .stage-select .checking-icon,html:has(#docs-pause-motion:checked) .stage-select .model-before,html:has(#docs-pause-motion:checked) .stage-prepare .offered,html:has(#docs-pause-motion:checked) .stage-prepare .downloading,html:has(#docs-pause-motion:checked) .stage-prepare .preparing,html:has(#docs-pause-motion:checked) .stage-prepare .checking-icon,html:has(#docs-pause-motion:checked) .stage-prepare .download-icon,html:has(#docs-pause-motion:checked) .stage-prepare .prepare-action,html:has(#docs-pause-motion:checked) .stage-prepare .progress-track,html:has(#docs-pause-motion:checked) .stage-save .save-idle{opacity:0}
html:has(#docs-pause-motion:checked) .stage-select .provider-after,html:has(#docs-pause-motion:checked) .stage-select .status-panel,html:has(#docs-pause-motion:checked) .stage-select .offered,html:has(#docs-pause-motion:checked) .stage-select .download-icon,html:has(#docs-pause-motion:checked) .stage-select .prepare-action,html:has(#docs-pause-motion:checked) .stage-select .model-after,html:has(#docs-pause-motion:checked) .stage-prepare .ready,html:has(#docs-pause-motion:checked) .stage-prepare .ready-icon,html:has(#docs-pause-motion:checked) .stage-save .save-done{opacity:1}
html:has(#docs-pause-motion:checked) .provider-options{opacity:0}html:has(#docs-pause-motion:checked) .stage-select .model-box{opacity:.55}
html:has(#docs-pause-motion:checked) .pointer{display:none}
@media(prefers-reduced-motion:reduce){.browser-scene *{animation:none!important}.stage-select .provider-before,.stage-select .url-area,.stage-select .checking,.stage-select .checking-icon,.stage-select .model-before,.stage-prepare .offered,.stage-prepare .downloading,.stage-prepare .preparing,.stage-prepare .checking-icon,.stage-prepare .download-icon,.stage-prepare .prepare-action,.stage-prepare .progress-track,.stage-save .save-idle,.provider-options{opacity:0}.stage-select .provider-after,.stage-select .status-panel,.stage-select .offered,.stage-select .download-icon,.stage-select .prepare-action,.stage-select .model-after,.stage-prepare .ready,.stage-prepare .ready-icon,.stage-save .save-done{opacity:1}.stage-select .model-box{opacity:.55}.pointer{display:none}}
</style>
