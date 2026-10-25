<script setup lang="ts">
import { BookmarkPlusIcon, CheckCircle2Icon, ChevronDownIcon, DownloadIcon, LinkIcon, Loader2Icon, MousePointer2Icon, SaveIcon } from 'lucide-vue-next';
import SettingsCameraFrame from './SettingsCameraFrame.vue';
import type { messages as english } from '../../pages/endpoint-type-browser-provided-lm/messages/en';

defineProps<{ stage: 'open' | 'select' | 'prepare' | 'save'; messages: typeof english }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="endpoint-scene browser-scene" :class="`stage-${stage}`">
    <SettingsCameraFrame :focus="stage" :messages="messages" :animation-id="`browser-provided-${stage}`" :test-id="`browser-provided-settings-${stage}`">
      <div class="guide-content">
        <div class="connection-toolbar"><span class="copy-url"><LinkIcon :size="13" />{{ messages.copy_setup_url }}</span></div>
        <div class="connection-layout">
          <div class="field provider-field">
            <span class="field-label">{{ messages.api_provider }}</span>
            <div class="field-box"><span class="layered"><span class="provider-before">{{ messages.ollama }}</span><span class="provider-after">{{ messages.browser_provided_provider_option }}</span></span><ChevronDownIcon :size="17" /><MousePointer2Icon v-if="stage === 'select'" class="pointer provider-pointer" :size="23" /></div>
            <div v-if="stage === 'select'" class="provider-options"><span>{{ messages.ollama }}</span><span class="provider-option-target">{{ messages.browser_provided_provider_option }}<MousePointer2Icon class="pointer option-pointer" :size="23" /></span></div>
          </div>
          <div class="connection-details conditional-area">
            <div class="url-area field"><span class="field-label">{{ messages.endpoint_url }}</span><div class="field-box url-box">{{ messages.local_url_placeholder }}</div></div>
            <div class="status-panel">
              <p class="managed">{{ messages.browser_managed_model_note }}</p>
              <div class="status-line"><span class="status-icon"><DownloadIcon class="offered-icon" :size="17" /><Loader2Icon class="preparing-icon spinner" :size="17" /><CheckCircle2Icon class="ready-icon" :size="17" /></span><span class="status-copy"><span class="offered">{{ messages.prepare_browser_model }}</span><span class="downloading">{{ messages.downloading_browser_model }}</span><span class="preparing">{{ messages.preparing_browser_model }}</span><span class="ready">{{ messages.browser_model_ready }}</span></span></div>
              <span class="prepare-action">{{ messages.prepare_browser_model }}<MousePointer2Icon v-if="stage === 'prepare'" class="pointer provider-pointer" :size="23" /></span>
              <div class="progress-track"><span /></div>
            </div>
          </div>
          <div class="field model-section">
            <span class="field-label">{{ messages.default_model }}</span>
            <div class="field-box" :class="{ 'disabled-model': stage !== 'open' }"><span class="layered"><span class="model-before">{{ messages.none }}</span><span class="model-after">{{ messages.browser_model_id }}</span></span><ChevronDownIcon :size="17" /></div>
            <small>{{ messages.inherited_connection_note }}</small>
          </div>
        </div>
      </div>
      <template #footer><span class="secondary-save"><BookmarkPlusIcon :size="15" />{{ messages.save_as_new_profile }}</span><span class="save-action"><span class="save-idle"><SaveIcon :size="15" />{{ messages.save_changes }}</span><span class="save-done"><CheckCircle2Icon :size="15" />{{ messages.settings_saved }}</span><MousePointer2Icon v-if="stage === 'save'" class="pointer save-pointer" :size="23" /></span></template>
    </SettingsCameraFrame>
  </div>
</template>

<style scoped>
.conditional-area {
  display: grid;
  min-height: 220px;
}
.conditional-area>* {
  grid-area: 1/1;
}
.status-panel {
  display: grid;
  align-content: start;
  gap: 12px;
  opacity: 0;
  padding: 14px;
  border: 1px solid color-mix(in srgb,var(--accent) 25%,var(--line));
  border-radius: 12px;
  background: color-mix(in srgb,var(--accent) 5%,var(--panel));
}
.managed {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.7;
}
.status-line {
  display: flex;
  align-items: start;
  gap: 7px;
  font-size: 11px;
  line-height: 1.7;
}
.status-icon,.status-copy {
  display: grid;
}
.status-icon>* ,.status-copy>* {
  grid-area: 1/1;
}
.status-icon {
  padding-top: 2px;
  color: var(--accent);
}
.downloading,.preparing,.ready,.preparing-icon,.ready-icon {
  opacity: 0;
}
.prepare-action {
  position: relative;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
  font-size: 11px;
  color: var(--accent);
}
.progress-track {
  height: 5px;
  overflow: hidden;
  border-radius: 5px;
  background: var(--field);
  opacity: 0;
}
.progress-track>span {
  display: block;
  height: 100%;
  background: var(--accent);
  animation: browser-progress 10s linear infinite;
}
.stage-select .url-area,.stage-select .model-before {
  animation: browser-before-choice 9s linear infinite;
}
.stage-select .status-panel,.stage-select .model-after {
  animation: browser-after-choice 9s linear infinite;
}
.stage-prepare .url-area,.stage-save .url-area,.stage-prepare .model-before,.stage-save .model-before {
  opacity: 0;
}
.stage-prepare .status-panel,.stage-save .status-panel,.stage-prepare .model-after,.stage-save .model-after {
  opacity: 1;
}
.stage-prepare .offered,.stage-prepare .offered-icon,.stage-prepare .prepare-action {
  animation: browser-offered 10s linear infinite;
}
.stage-prepare .downloading,.stage-prepare .preparing-icon,.stage-prepare .progress-track {
  animation: browser-downloading 10s linear infinite;
}
.stage-prepare .preparing {
  animation: browser-preparing 10s linear infinite;
}
.stage-prepare .ready,.stage-prepare .ready-icon {
  animation: browser-ready 10s linear infinite;
}
.stage-save .offered,.stage-save .offered-icon,.stage-save .prepare-action {
  opacity: 0;
}
.stage-save .ready,.stage-save .ready-icon {
  opacity: 1;
}
.disabled-model {
  opacity: .55;
}
@keyframes browser-offered {
  0%,24%,100% {
    opacity: 1;
  }
  32%,92% {
    opacity: 0;
  }
}
@keyframes browser-downloading {
  0%,28%,65%,100% {
    opacity: 0;
  }
  35%,60% {
    opacity: 1;
  }
}
@keyframes browser-preparing {
  0%,61%,76%,100% {
    opacity: 0;
  }
  66%,72% {
    opacity: 1;
  }
}
@keyframes browser-ready {
  0%,74%,100% {
    opacity: 0;
  }
  80%,92% {
    opacity: 1;
  }
}
@keyframes browser-progress {
  0%,28%,100% {
    width: 0;
  }
  65%,92% {
    width: 100%;
  }
}
html:has(#docs-pause-motion:checked) .stage-select .url-area,html:has(#docs-pause-motion:checked) .stage-select .model-before,html:has(#docs-pause-motion:checked) .stage-prepare .offered,html:has(#docs-pause-motion:checked) .stage-prepare .offered-icon,html:has(#docs-pause-motion:checked) .stage-prepare .prepare-action,html:has(#docs-pause-motion:checked) .stage-prepare .progress-track {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .stage-select .status-panel,html:has(#docs-pause-motion:checked) .stage-select .model-after,html:has(#docs-pause-motion:checked) .stage-prepare .ready,html:has(#docs-pause-motion:checked) .stage-prepare .ready-icon {
  opacity: 1;
}
@media(prefers-reduced-motion:reduce) {
  .stage-select .url-area,.stage-select .model-before,.stage-prepare .offered,.stage-prepare .offered-icon,.stage-prepare .prepare-action,.stage-prepare .progress-track {
    opacity: 0;
  }
  .stage-select .status-panel,.stage-select .model-after,.stage-prepare .ready,.stage-prepare .ready-icon {
    opacity: 1;
  }
}
@keyframes browser-before-choice {
  0%,23%,100% {
    opacity: 1;
  }
  35%,92% {
    opacity: 0;
  }
}
@keyframes browser-after-choice {
  0%,23%,100% {
    opacity: 0;
  }
  35%,92% {
    opacity: 1;
  }
}
</style>
