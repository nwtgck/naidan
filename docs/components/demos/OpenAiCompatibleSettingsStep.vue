<script setup lang="ts">
import { ActivityIcon, BookmarkPlusIcon, BotIcon, CheckCircle2Icon, CheckIcon, ChevronDownIcon, GlobeIcon, LinkIcon, Loader2Icon, MousePointer2Icon, PlusIcon, RefreshCwIcon, SaveIcon, SearchIcon, Trash2Icon } from 'lucide-vue-next';
import SettingsCameraFrame from './SettingsCameraFrame.vue';
import type { messages as english } from '../../pages/endpoint-type-openai/messages/en';

defineProps<{
  stage: 'open' | 'provider' | 'headers' | 'check' | 'model',
  messages: typeof english,
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="openai-scene" :class="`stage-${stage}`">
    <SettingsCameraFrame :focus="stage" :messages="messages" :animation-id="`openai-compatible-${stage}`" :test-id="`openai-compatible-settings-${stage}`">
      <div class="guide-content">
        <div class="section-heading">
          <div><GlobeIcon :size="19" /><strong>{{ messages.endpoint_configuration }}</strong></div>
          <span class="copy-url"><LinkIcon :size="13" />{{ messages.copy_setup_url }}</span>
        </div>

        <div class="field provider-field">
          <span class="field-label">{{ messages.api_provider }}</span>
          <div class="field-box">
            <span class="layered"><span class="provider-before">{{ messages.ollama }}</span><span class="provider-after">{{ messages.openai_compatible }}</span></span>
            <ChevronDownIcon :size="17" />
            <MousePointer2Icon v-if="stage === 'provider'" class="pointer provider-pointer" :size="25" />
          </div>
          <div v-if="stage === 'provider'" class="provider-options">
            <span>{{ messages.ollama }}</span>
            <span class="provider-option-target">{{ messages.openai_compatible }}<MousePointer2Icon class="pointer option-pointer" :size="25" /></span>
          </div>
        </div>

        <div class="field url-field">
          <div class="field-heading"><span class="field-label">{{ messages.endpoint_url }}</span>
            <span class="presets">
              <span class="preset ollama-preset">Ollama (local)</span>
              <span class="preset lm-studio">{{ messages.lm_studio_local_preset }}<MousePointer2Icon v-if="stage === 'provider'" class="pointer preset-pointer" :size="25" /></span>
              <span class="preset">{{ messages.llama_server_local_preset }}</span>
            </span>
          </div>
          <div class="url-row">
            <div class="field-box url-box"><span class="layered"><span class="url-before">http://localhost:11434</span><span class="url-after">http://localhost:1234/v1</span></span></div>
            <div class="check-action">
              <span class="check-idle"><ActivityIcon :size="17" />{{ messages.check_connection }}</span>
              <span class="check-loading"><Loader2Icon class="spinner" :size="17" />{{ messages.check_connection }}</span>
              <span class="check-done"><CheckIcon :size="17" />{{ messages.connected }}</span>
              <MousePointer2Icon v-if="stage === 'check'" class="pointer check-pointer" :size="25" />
            </div>
          </div>
          <div class="auto-hint"><GlobeIcon :size="16" />{{ messages.localhost_auto_check_note }}</div>
        </div>

        <div class="field headers-field">
          <div class="field-heading">
            <span class="field-label">{{ messages.custom_http_headers }}</span>
            <span class="add-header"><PlusIcon :size="14" />{{ messages.add_header }}<MousePointer2Icon v-if="stage === 'headers'" class="pointer header-pointer" :size="25" /></span>
          </div>
          <div class="header-state">
            <span class="no-headers">{{ messages.no_custom_headers }}</span>
            <span class="header-row"><span>{{ messages.http_header_name }}</span><span>{{ messages.http_header_value }}</span><Trash2Icon :size="16" /><MousePointer2Icon v-if="stage === 'headers'" class="pointer remove-pointer" :size="25" /></span>
          </div>
        </div>

        <div class="model-section">
          <div class="section-heading"><div><BotIcon :size="19" /><strong>{{ messages.model_selection }}</strong></div></div>
          <div class="field">
            <span class="field-label">{{ messages.default_model }}</span>
            <div class="field-box model-box"><span class="layered"><span class="model-before">{{ messages.none }}</span><span class="model-after">{{ messages.sample_server_model }}</span></span><ChevronDownIcon :size="17" /><MousePointer2Icon v-if="stage === 'model'" class="pointer model-pointer" :size="25" /></div>
            <div v-if="stage === 'model'" class="model-options"><div class="model-options-tools"><span class="model-search"><SearchIcon :size="14" />{{ messages.filter_models }}</span><span class="model-refresh" :title="messages.refresh_model_list"><RefreshCwIcon :size="14" /></span></div><span class="model-option"><span>{{ messages.none }}</span><CheckIcon :size="14" /></span><strong class="model-option model-option-target">{{ messages.sample_server_model }}<MousePointer2Icon class="pointer model-option-pointer" :size="22" /></strong></div>
            <small>{{ messages.inherited_default_note }}</small>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="secondary-save"><BookmarkPlusIcon :size="16" />{{ messages.save_as_new_profile }}</div>
        <div class="save-action"><span class="save-idle"><SaveIcon :size="16" />{{ messages.save_changes }}</span><span class="save-done"><CheckCircle2Icon :size="16" />{{ messages.settings_saved }}</span><MousePointer2Icon v-if="stage === 'model'" class="pointer save-pointer" :size="25" /></div>
      </template>
    </SettingsCameraFrame>
  </div>
</template>

<style scoped>
.openai-scene {
  --field:var(--surface-2);
  --panel:var(--surface);
  --line:var(--line-strong);
  --ink:var(--text);
  --muted:var(--muted);
  --accent:var(--blue);
  font: 14px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.guide-content {
  width: 570px;
  color: var(--ink);
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  font-size: 18px;
}
.section-heading>div {
  display: flex;
  align-items: center;
  gap: 10px;
}
.section-heading svg {
  color: var(--accent);
}
.copy-url {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb,var(--accent) 25%,var(--line));
  border-radius: 8px;
  background: color-mix(in srgb,var(--accent) 6%,var(--panel));
  color: var(--accent);
  font-size: 11px;
  font-weight: 750;
}
.field {
  position: relative;
  display: grid;
  gap: 8px;
  margin-top: 23px;
}
.field-label {
  color: var(--muted);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.provider-options {
  position: absolute;
  z-index: 4;
  top: 100%;
  left: 0;
  right: 0;
  display: grid;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--panel);
  box-shadow: 0 14px 30px #0004;
  opacity: 0;
  transform: translateY(-7px) scaleY(.94);
  transform-origin: top;
  animation: provider-options 9s linear infinite;
}
.provider-options>span {
  position: relative;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 700;
}
.provider-option-target {
  color: var(--accent);
  background: color-mix(in srgb,var(--accent) 12%,var(--panel));
}
.stage-provider .provider-field .field-box>svg:not(.pointer) {
  animation: provider-chevron 9s linear infinite;
}
.field-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 44px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--field);
  font-weight: 700;
  overflow-wrap: anywhere;
}
.field-box>svg:not(.pointer) {
  flex: none;
  color: var(--muted);
}
.layered {
  display: grid;
  min-width: 0;
}
.layered>span {
  grid-area: 1/1;
  overflow-wrap: anywhere;
}
.provider-before,.url-before,.model-before {
  opacity: 1;
}
.provider-after,.url-after,.model-after {
  opacity: 0;
}
.stage-provider .provider-before {
  animation: provider-before 9s linear infinite;
}
.stage-provider .provider-after {
  animation: provider-after 9s linear infinite;
}
.stage-headers .provider-before,.stage-check .provider-before,.stage-model .provider-before,.stage-headers .url-before,.stage-check .url-before,.stage-model .url-before {
  opacity: 0;
}
.stage-headers .provider-after,.stage-check .provider-after,.stage-model .provider-after,.stage-headers .url-after,.stage-check .url-after,.stage-model .url-after {
  opacity: 1;
}
.field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}
.preset {
  position: relative;
  padding: 4px 7px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--muted);
  font-size: 10px;
  font-weight: 750;
  white-space: nowrap;
}
.stage-open .ollama-preset,.stage-provider .ollama-preset {
  color: var(--accent);
  border-color: color-mix(in srgb,var(--accent) 50%,var(--line));
  background: color-mix(in srgb,var(--accent) 10%,var(--panel));
}
.stage-provider .ollama-preset {
  animation: old-preset 9s linear infinite;
}
.stage-provider .lm-studio {
  animation: new-preset 9s linear infinite;
}
.stage-headers .lm-studio,.stage-check .lm-studio,.stage-model .lm-studio {
  color: var(--accent);
  border-color: color-mix(in srgb,var(--accent) 50%,var(--line));
  background: color-mix(in srgb,var(--accent) 10%,var(--panel));
}
.url-row {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto;
  gap: 9px;
}
.url-box {
  font: 13px/1.4 ui-monospace,SFMono-Regular,monospace;
}
.stage-provider .url-before {
  animation: url-before 9s linear infinite;
}
.stage-provider .url-after {
  animation: url-after 9s linear infinite;
}
.check-action,.save-action {
  position: relative;
  display: grid;
  min-width: 0;
}
.check-action {
  min-width: 180px;
}
.check-action>span,.save-action>span {
  grid-area: 1/1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  padding: 9px 13px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--field);
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  text-align: center;
  white-space: nowrap;
}
.check-action svg,.save-action svg {
  flex: none;
}
.check-loading,.check-done,.save-done {
  opacity: 0;
}
.check-done,.save-done {
  color: var(--green)!important;
  border-color: color-mix(in srgb,var(--green) 50%,var(--line))!important;
  background: color-mix(in srgb,var(--green) 10%,var(--panel))!important;
}
.stage-check .check-idle {
  animation: check-idle 9s linear infinite;
}
.stage-check .check-loading {
  animation: check-loading 9s linear infinite;
}
.stage-check .check-done {
  animation: check-done 9s linear infinite;
}
.stage-model .check-idle {
  animation: connected-reset-idle 10s linear infinite;
}
.stage-model .check-done {
  animation: connected-reset-done 10s linear infinite;
}
.spinner {
  animation: spinner 650ms linear infinite;
}
.auto-hint {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb,var(--accent) 20%,var(--line));
  border-radius: 11px;
  background: color-mix(in srgb,var(--accent) 7%,var(--panel));
  color: var(--muted);
  font-size: 11px;
}
.auto-hint svg {
  flex: none;
  color: var(--accent);
}
.headers-field {
  margin-top: 25px;
}
.add-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
}
.stage-headers .add-header {
  animation: add-focus 9s linear infinite;
}
.header-state {
  display: grid;
  align-items: center;
  min-height: 43px;
}
.header-state>* {
  grid-area: 1/1;
}
.no-headers {
  font-size: 11px;
  font-style: italic;
  color: var(--muted);
}
.header-row {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  align-items: center;
  gap: 7px;
  opacity: 0;
}
.header-row>span {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--field);
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.header-row>svg:not(.pointer) {
  color: var(--muted);
}
.stage-headers .no-headers {
  animation: header-empty 9s linear infinite;
}
.stage-headers .header-row {
  animation: header-row 9s linear infinite;
}
.model-section {
  margin-top: 30px;
  padding-top: 15px;
  border-top: 1px solid var(--line);
}
.model-section .field {
  margin-top: 17px;
}
.model-box small {
  color: var(--muted);
}
.model-section small {
  font-size: 11px;
  color: var(--muted);
}
.model-options {
  position: absolute;
  z-index: 5;
  top: 76px;
  left: 0;
  width: min(400px,100%);
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--panel);
  box-shadow: 0 14px 30px #0005;
  opacity: 0;
  transform: translateY(-8px) scaleY(.94);
  transform-origin: top;
  animation: model-options 10s linear infinite;
}
.model-options-tools {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 6px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--field);
}
.model-search {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
}
.model-refresh {
  display: grid;
  place-items: center;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--muted);
}
.model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 29px;
  padding: 5px 9px;
  color: var(--muted);
  font-size: 12px;
}
.model-option>svg {
  color: var(--accent);
}
.model-option-target {
  position: relative;
  border-radius: 6px;
  color: var(--accent);
  background: color-mix(in srgb,var(--accent) 10%,var(--panel));
}
.model-option-pointer {
  right: 11px;
  bottom: -6px;
  animation: model-option-pointer 10s linear infinite;
}
.stage-model .model-box>svg:not(.pointer) {
  animation: model-chevron 10s linear infinite;
}
.stage-model .model-before {
  animation: model-before 10s linear infinite;
}
.stage-model .model-after {
  animation: model-after 10s linear infinite;
}
.stage-model :deep(.modal-scroll) {
  position: relative;
  z-index: 3;
  overflow: visible;
}
.secondary-save {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}
.save-action>span {
  padding: 10px 24px;
  background: #2563eb;
  border-color: #1d4ed8;
  color: white;
}
.save-action .save-idle {
  opacity: .55;
}
.stage-provider .save-idle,.stage-headers .save-idle,.stage-check .save-idle {
  opacity: 1;
}
.stage-model .save-idle {
  animation: save-idle 10s linear infinite;
}
.stage-model .save-done {
  animation: save-done 10s linear infinite;
}
.pointer {
  position: absolute;
  z-index: 3;
  right: 4px;
  bottom: -10px;
  color: var(--ink);
  fill: var(--panel);
  filter: drop-shadow(0 2px 3px #0008);
  pointer-events: none;
}
.provider-pointer {
  animation: provider-pointer 9s linear infinite;
}
.preset-pointer {
  animation: preset-pointer 9s linear infinite;
}
.header-pointer {
  animation: header-pointer 9s linear infinite;
}
.remove-pointer {
  animation: remove-pointer 9s linear infinite;
}
.check-pointer {
  animation: check-pointer 9s linear infinite;
}
.model-pointer {
  animation: model-pointer 10s linear infinite;
}
.save-pointer {
  animation: save-pointer 10s linear infinite;
}
@keyframes provider-options {
  0%,22%,36%,100% {
    opacity: 0;
    transform: translateY(-7px) scaleY(.94);
  }
  26%,33% {
    opacity: 1;
    transform: none;
  }
}
@keyframes provider-chevron {
  0%,22%,36%,100% {
    transform: none;
  }
  26%,33% {
    transform: rotate(180deg);
  }
}
@keyframes option-pointer {
  0%,26%,36%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  29%,33% {
    opacity: 1;
    transform: none;
  }
}
.option-pointer {
  right: auto;
  left: 175px;
  animation: option-pointer 9s linear infinite;
}
@keyframes provider-before {
  0%,24%,100% {
    opacity: 1;
  }
  35%,92% {
    opacity: 0;
  }
}
@keyframes provider-after {
  0%,24%,100% {
    opacity: 0;
  }
  35%,92% {
    opacity: 1;
  }
}
@keyframes old-preset {
  0%,24%,100% {
    color: var(--accent);
    border-color: var(--accent);
    background: color-mix(in srgb,var(--accent) 10%,var(--panel));
  }
  35%,92% {
    color: var(--muted);
    border-color: var(--line);
    background: var(--panel);
  }
}
@keyframes new-preset {
  0%,51%,100% {
    color: var(--muted);
    border-color: var(--line);
    background: var(--panel);
  }
  63%,92% {
    color: var(--accent);
    border-color: var(--accent);
    background: color-mix(in srgb,var(--accent) 10%,var(--panel));
  }
}
@keyframes url-before {
  0%,51%,100% {
    opacity: 1;
  }
  63%,92% {
    opacity: 0;
  }
}
@keyframes url-after {
  0%,51%,100% {
    opacity: 0;
  }
  63%,92% {
    opacity: 1;
  }
}
@keyframes check-idle {
  0%,25%,100% {
    opacity: 1;
  }
  36%,89% {
    opacity: 0;
  }
}
@keyframes check-loading {
  0%,25%,100% {
    opacity: 0;
  }
  36%,60% {
    opacity: 1;
  }
  70% {
    opacity: 0;
  }
}
@keyframes check-done {
  0%,60%,100% {
    opacity: 0;
  }
  70%,89% {
    opacity: 1;
  }
}
@keyframes spinner {
  to {
    transform: rotate(360deg);
  }
}
@keyframes connected-reset-idle {
  0%,20% {
    opacity: 0;
  }
  30%,92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes connected-reset-done {
  0%,20% {
    opacity: 1;
  }
  30%,92% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}
@keyframes add-focus {
  0%,11%,31%,100% {
    box-shadow: none;
  }
  17%,25% {
    box-shadow: 0 0 0 4px color-mix(in srgb,var(--accent) 20%,transparent);
  }
}
@keyframes header-empty {
  0%,30%,69%,100% {
    opacity: 1;
  }
  41%,59% {
    opacity: 0;
  }
}
@keyframes header-row {
  0%,30%,69%,100% {
    opacity: 0;
  }
  41%,59% {
    opacity: 1;
  }
}
@keyframes model-before {
  0%,26%,100% {
    opacity: 1;
  }
  38%,91% {
    opacity: 0;
  }
}
@keyframes model-after {
  0%,26%,100% {
    opacity: 0;
  }
  38%,91% {
    opacity: 1;
  }
}
@keyframes model-options {
  0%,20%,38%,100% {
    opacity: 0;
    transform: translateY(-8px) scaleY(.94);
  }
  24%,34% {
    opacity: 1;
    transform: none;
  }
}
@keyframes model-chevron {
  0%,20%,38%,100% {
    transform: none;
  }
  24%,34% {
    transform: rotate(180deg);
  }
}
@keyframes model-option-pointer {
  0%,25%,38%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  28%,34% {
    opacity: 1;
    transform: none;
  }
}
@keyframes save-idle {
  0%,62%,100% {
    opacity: 1;
  }
  74%,91% {
    opacity: 0;
  }
}
@keyframes save-done {
  0%,62%,100% {
    opacity: 0;
  }
  74%,91% {
    opacity: 1;
  }
}
@keyframes provider-pointer {
  0%,8%,31%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  15%,22% {
    opacity: 1;
    transform: none;
  }
}
@keyframes preset-pointer {
  0%,49%,68%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  55%,61% {
    opacity: 1;
    transform: none;
  }
}
@keyframes header-pointer {
  0%,10%,29%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  17%,23% {
    opacity: 1;
    transform: none;
  }
}
@keyframes remove-pointer {
  0%,59%,79%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  67%,73% {
    opacity: 1;
    transform: none;
  }
}
@keyframes check-pointer {
  0%,7%,27%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  13%,20% {
    opacity: 1;
    transform: none;
  }
}
@keyframes model-pointer {
  0%,9%,29%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  16%,23% {
    opacity: 1;
    transform: none;
  }
}
@keyframes save-pointer {
  0%,62%,81%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  68%,75% {
    opacity: 1;
    transform: none;
  }
}
@media(max-width:700px) {
  .guide-content {
    width: 460px;
  }
  .section-heading {
    font-size: 16px;
  }
  .field-heading {
    align-items: flex-start;
  }
  .presets {
    max-width: 300px;
  }
  .url-row {
    grid-template-columns: minmax(0,1fr) auto;
  }
  .field-box {
    font-size: 13px;
  }
  .url-box {
    font-size: 11px;
  }
  .check-action {
    min-width: 150px;
  }
  .check-action>span {
    font-size: 11px;
    padding-inline: 8px;
  }
  .auto-hint {
    font-size: 10px;
  }
  .secondary-save {
    font-size: 10px;
  }
  .model-options {
    width: 280px;
  }
}
html:has(#docs-pause-motion:checked) .openai-scene * {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .stage-provider .provider-before,html:has(#docs-pause-motion:checked) .stage-provider .url-before,html:has(#docs-pause-motion:checked) .stage-check .check-idle,html:has(#docs-pause-motion:checked) .stage-check .check-loading,html:has(#docs-pause-motion:checked) .stage-model .model-before,html:has(#docs-pause-motion:checked) .stage-model .save-idle {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .stage-provider .provider-after,html:has(#docs-pause-motion:checked) .stage-provider .url-after,html:has(#docs-pause-motion:checked) .stage-check .check-done,html:has(#docs-pause-motion:checked) .stage-model .model-after,html:has(#docs-pause-motion:checked) .stage-model .save-done {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .stage-model .check-idle {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .stage-model .check-done {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .stage-headers .no-headers {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .stage-headers .header-row {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .provider-options,html:has(#docs-pause-motion:checked) .model-options {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .pointer {
  display: none;
}
@media(prefers-reduced-motion:reduce) {
  .openai-scene * {
    animation: none!important;
  }
  .stage-provider .provider-before,.stage-provider .url-before,.stage-check .check-idle,.stage-check .check-loading,.stage-model .check-done,.stage-model .model-before,.stage-model .save-idle,.provider-options,.model-options {
    opacity: 0;
  }
  .stage-provider .provider-after,.stage-provider .url-after,.stage-check .check-done,.stage-model .check-idle,.stage-model .model-after,.stage-model .save-done {
    opacity: 1;
  }
  .stage-headers .no-headers {
    opacity: 1;
  }
  .stage-headers .header-row {
    opacity: 0;
  }
  .pointer {
    display: none;
  }
}
</style>
