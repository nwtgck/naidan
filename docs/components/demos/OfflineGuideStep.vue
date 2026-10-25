<script setup lang="ts">
import { CheckIcon, CloudDownloadIcon, FileCode2Icon, HardDriveIcon, MessageSquareIcon, RotateCwIcon, SendIcon, WifiIcon, WifiOffIcon } from 'lucide-vue-next';
import logo from '../../assets/naidan.svg';
import type { messages as englishMessages } from '../../pages/pwa/messages/en';

defineProps<{ stage: 'prepare' | 'model' | 'verify' | 'update'; messages: typeof englishMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="offline-step" :class="`stage-${stage}`" :data-testid="`offline-step-${stage}`" data-docs-animation="offline-guide" aria-hidden="true">
    <template v-if="stage === 'prepare'">
      <div class="prepare-layout">
        <div class="source-card">
          <span class="connection"><WifiIcon :size="14" />{{ messages.connected_status }}</span>
          <div class="source-brand"><img :src="logo" width="27" height="27" alt=""><strong>Naidan</strong></div>
          <code>/#/</code>
          <span class="source-label">{{ messages.hosted_naidan }}</span>
        </div>
        <CloudDownloadIcon class="flow-arrow" :size="25" />
        <div class="storage-card">
          <HardDriveIcon :size="21" />
          <strong>{{ messages.browser_app_files }}</strong>
          <div class="progress-track"><span /></div>
          <div class="stage-status"><span class="status-before">{{ messages.saving_application_files }}</span><span class="status-after"><CheckIcon :size="13" />{{ messages.app_files_saved }}</span></div>
        </div>
      </div>
    </template>

    <template v-else-if="stage === 'model'">
      <div class="model-layout">
        <div class="model-card">
          <span class="connection"><WifiIcon :size="14" />{{ messages.connected_status }}</span>
          <FileCode2Icon class="file-icon" :size="25" />
          <code>{{ messages.model_file_name }}</code>
          <strong><CheckIcon :size="13" />{{ messages.selected_local_model }}</strong>
        </div>
        <div class="chat-card">
          <span class="chat-title"><MessageSquareIcon :size="15" />{{ messages.chat_label }}</span>
          <div class="question">{{ messages.sample_question }}<SendIcon :size="12" /></div>
          <div class="answer">{{ messages.sample_answer }}</div>
        </div>
      </div>
    </template>

    <template v-else-if="stage === 'verify'">
      <div class="verify-browser">
        <div class="browser-bar"><span class="browser-dots"><i /><i /><i /></span><code>/#/</code><span class="offline-badge"><WifiOffIcon :size="13" />{{ messages.offline_status }}</span><RotateCwIcon class="reload-icon" :size="15" /></div>
        <div class="verify-app"><div class="app-brand"><img :src="logo" width="21" height="21" alt=""><strong>Naidan</strong></div><div class="verify-chat"><span class="chat-title"><MessageSquareIcon :size="14" />{{ messages.chat_label }}</span><span class="verify-question">{{ messages.sample_question }}</span><span class="verify-answer">{{ messages.sample_answer }}</span></div></div>
      </div>
    </template>

    <template v-else>
      <div class="update-app">
        <aside class="update-sidebar">
          <div class="update-brand"><img :src="logo" width="21" height="21" alt=""><strong>Naidan</strong></div>
          <div class="update-button"><RotateCwIcon :size="15" /><span class="update-label"><span class="update-before">{{ messages.preparing_update_label }}</span><span class="update-after">{{ messages.ready_update_label }}</span></span></div>
          <p class="update-warning">{{ messages.network_update_warning }}</p>
          <div class="new-chat"><MessageSquareIcon :size="13" />{{ messages.new_chat_label }}</div>
        </aside>
        <div class="update-main"><div class="update-main-header">{{ messages.chat_label }}</div><div class="update-main-blank" /></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.offline-step {
  box-sizing: border-box;
  max-width: 680px;
  height: 238px;
  padding: 16px;
  border: 1px solid var(--line-strong);
  border-radius: 15px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.55 ui-sans-serif,system-ui,sans-serif;
  overflow: hidden;
}
.offline-step * {
  box-sizing: border-box;
}
.prepare-layout,.model-layout {
  display: grid;
  grid-template-columns: minmax(0,1fr) 28px minmax(0,1fr);
  align-items: center;
  gap: 13px;
  height: 100%;
}
.source-card,.storage-card,.model-card,.chat-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 184px;
  padding: 15px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface-2);
  overflow: hidden;
}
.connection {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--blue);
  font-size: 11px;
  font-weight: 750;
}
.source-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 20px 0 6px;
  font-size: 18px;
  letter-spacing: -.03em;
}
.source-card code {
  font: 11px/1.5 ui-monospace,monospace;
  overflow-wrap: anywhere;
}
.source-label {
  margin-top: auto;
  color: var(--muted);
  font-size: 11px;
}
.flow-arrow {
  color: var(--blue);
  justify-self: center;
  animation: flow-arrive 7s ease-in-out infinite;
}
.storage-card > svg {
  color: var(--blue);
  margin-bottom: 12px;
}
.storage-card strong {
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.progress-track {
  height: 7px;
  flex: none;
  margin: 15px 0 10px;
  border-radius: 20px;
  background: color-mix(in srgb,var(--blue) 15%,var(--surface));
  overflow: hidden;
}
.progress-track span {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--blue);
  transform: scaleX(.08);
  transform-origin: left;
  animation: save-progress 7s ease-in-out infinite;
}
.stage-status {
  display: grid;
  min-height: 35px;
  align-items: start;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted);
}
.stage-status > span {
  grid-area: 1/1;
}
.status-before {
  animation: fade-before 7s linear infinite;
}
.status-after {
  display: inline-flex;
  align-items: flex-start;
  gap: 5px;
  color: var(--blue);
  opacity: 0;
  animation: fade-after 7s linear infinite;
}
.status-after svg {
  flex: none;
  margin-top: 1px;
}
.model-layout {
  grid-template-columns: minmax(0,1fr) minmax(0,1.1fr);
  gap: 14px;
}
.model-card .file-icon {
  color: var(--blue);
  margin: 19px 0 6px;
}
.model-card code {
  font: 12px/1.5 ui-monospace,monospace;
  overflow-wrap: anywhere;
}
.model-card strong {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: auto;
  color: var(--blue);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.model-card strong svg {
  flex: none;
}
.chat-card {
  background: var(--bg);
  color: var(--text);
  border-color: var(--line-strong);
}
.chat-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  font-weight: 700;
}
.question,.answer {
  max-width: 90%;
  padding: 9px 11px;
  border-radius: 9px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.question {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  align-self: end;
  margin-top: 28px;
  background: #1d4ed8;
  color: white;
}
.answer {
  align-self: start;
  margin-top: 10px;
  background: var(--surface-3);
  color: var(--text);
  opacity: 0;
  animation: answer-appear 7s linear infinite;
}
.verify-browser {
  height: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.browser-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 7px 11px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-2);
}
.browser-dots {
  display: flex;
  gap: 4px;
  flex: none;
}
.browser-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--subtle);
}
.browser-bar code {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 5px;
  background: var(--bg);
  color: var(--muted);
  font: 10px/1.5 ui-monospace,monospace;
  overflow-wrap: anywhere;
}
.offline-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--green);
  font-size: 10px;
  font-weight: 700;
}
.reload-icon {
  flex: none;
  color: var(--muted);
  animation: reload-turn 8s ease-in-out infinite;
}
.verify-app {
  display: grid;
  grid-template-columns: 145px minmax(0,1fr);
  height: calc(100% - 42px);
}
.app-brand {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 16px 12px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  font-size: 14px;
}
.verify-chat {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  padding: 14px 18px;
}
.verify-question,.verify-answer {
  max-width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.verify-question {
  align-self: flex-end;
  margin-top: 18px;
  background: #1d4ed8;
  color: white;
}
.verify-answer {
  margin-top: 9px;
  background: var(--surface-3);
  opacity: 0;
  animation: verify-answer 8s linear infinite;
}
.update-app {
  display: grid;
  grid-template-columns: 255px minmax(0,1fr);
  height: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}
.update-sidebar {
  padding: 13px 12px;
  border-right: 1px solid var(--line);
  background: var(--surface);
}
.update-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 0 4px;
  font-size: 15px;
}
.update-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 41px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb,var(--green) 50%,var(--line));
  border-radius: 11px;
  background: color-mix(in srgb,var(--green) 10%,var(--surface));
  color: var(--green);
  font-size: 10px;
  line-height: 1.4;
  font-weight: 750;
  text-align: center;
}
.update-button > svg {
  flex: none;
}
.update-label {
  display: grid;
  min-width: 0;
}
.update-label > span {
  grid-area: 1/1;
  overflow-wrap: anywhere;
}
.update-before {
  animation: update-before 8s linear infinite;
}
.update-after {
  opacity: 0;
  animation: update-after 8s linear infinite;
}
.update-warning {
  height: 62px;
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 9px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  opacity: 0;
  animation: update-warning 8s linear infinite;
}
.new-chat {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 9px;
  background: #2563eb;
  color: white;
  font-size: 11px;
  font-weight: 700;
}
.update-main-header {
  padding: 15px;
  border-bottom: 1px solid var(--line-strong);
  font-size: 11px;
  font-weight: 750;
}
.update-main-blank {
  width: 65%;
  height: 8px;
  margin: 24px auto;
  border-radius: 10px;
  background: var(--surface-3);
  opacity: .35;
}
@keyframes flow-arrive {
  0%,12% {
    opacity: .3;
    transform: translateX(-5px);
  }
  35%,90% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: .3;
    transform: translateX(-5px);
  }
}
@keyframes save-progress {
  0%,16% {
    transform: scaleX(.08);
  }
  61%,91% {
    transform: scaleX(1);
  }
  100% {
    transform: scaleX(.08);
  }
}
@keyframes fade-before {
  0%,53% {
    opacity: 1;
  }
  64%,91% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}
@keyframes fade-after {
  0%,53% {
    opacity: 0;
  }
  64%,91% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes answer-appear {
  0%,36% {
    opacity: 0;
    transform: translateY(4px);
  }
  52%,91% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes reload-turn {
  0%,20% {
    transform: rotate(0);
  }
  38%,100% {
    transform: rotate(360deg);
  }
}
@keyframes verify-answer {
  0%,47% {
    opacity: 0;
    transform: translateY(4px);
  }
  63%,91% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes update-before {
  0%,25% {
    opacity: 1;
  }
  33%,91% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}
@keyframes update-after {
  0%,25% {
    opacity: 0;
  }
  33%,91% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes update-warning {
  0%,25% {
    opacity: 0;
  }
  33%,57% {
    opacity: 1;
  }
  67%,100% {
    opacity: 0;
  }
}
html:has(#docs-pause-motion:checked) .offline-step *,
html:has(#docs-pause-motion:checked) .offline-step *::before,
html:has(#docs-pause-motion:checked) .offline-step *::after {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .offline-step .progress-track span {
  transform: scaleX(1);
}
html:has(#docs-pause-motion:checked) .offline-step .status-before,
html:has(#docs-pause-motion:checked) .offline-step .update-before,
html:has(#docs-pause-motion:checked) .offline-step .update-warning {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .offline-step .status-after,
html:has(#docs-pause-motion:checked) .offline-step .update-after,
html:has(#docs-pause-motion:checked) .offline-step .answer,
html:has(#docs-pause-motion:checked) .offline-step .verify-answer {
  opacity: 1;
  transform: none;
}
@media(max-width:520px) {
  .offline-step {
    padding: 11px;
    height: 238px;
  }
  .prepare-layout {
    grid-template-columns: minmax(0,1fr) 17px minmax(0,1fr);
    gap: 5px;
  }
  .source-card,.storage-card,.model-card,.chat-card {
    padding: 10px;
    height: 190px;
  }
  .source-brand {
    gap: 5px;
    font-size: 14px;
  }
  .source-brand img {
    width: 22px;
    height: 22px;
  }
  .flow-arrow {
    width: 18px;
  }
  .model-layout {
    gap: 7px;
  }
  .model-card strong,.stage-status {
    font-size: 10px;
  }
  .question,.answer {
    padding: 7px;
    font-size: 11px;
  }
  .app-brand {
    padding: 13px 7px;
    font-size: 11px;
  }
  .verify-app {
    grid-template-columns: 100px minmax(0,1fr);
  }
  .verify-chat {
    padding: 13px 10px;
  }
  .update-app {
    grid-template-columns: minmax(0,1fr);
  }
  .update-main {
    display: none;
  }
  .update-sidebar {
    border-right: 0;
  }
  .offline-badge {
    font-size: 9px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .offline-step *, .offline-step *::before, .offline-step *::after {
    animation: none!important;
  }
  .progress-track span {
    transform: scaleX(1);
  }
  .status-before,.update-before,.update-warning {
    opacity: 0;
  }
  .status-after,.update-after,.answer,.verify-answer {
    opacity: 1;
    transform: none;
  }
}
</style>
